#!/usr/bin/env node
// The build loop's cost report. Reads a workflow
// run's agent transcripts and writes what each agent used: turns, tool calls,
// context read (cache reads plus cache writes plus fresh input) and output.
// Writes docs/build-loop/runs/<slug>/cost.md and adds the run to
// docs/build-loop/costs.json, which `run.mjs start` uses to estimate the next
// run before it starts.
//
//   node scripts/loop/cost.mjs --slug invoices --latest       the newest workflow run
//   node scripts/loop/cost.mjs --slug invoices --dir <path>    a given transcript folder
//   node scripts/loop/cost.mjs --latest --peek                 spend so far, nothing written
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { homedir } from 'node:os'
import { basename, join, relative } from 'node:path'
import { COSTS_FILE, MAIN_ROOT, ROOT, RUNS_DIR } from './lib/loop-config.mjs'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const slug = arg('slug') ?? 'change'

/**
 * Every workflow transcript folder of this project, newest first. A session
 * started in the main checkout keeps its transcripts there even after it moves
 * into a run's worktree, so both project folders are read.
 */
function workflowDirs() {
  const projects = [...new Set([MAIN_ROOT, ROOT])]
    .map((root) => join(homedir(), '.claude', 'projects', root.replace(/[/.]/g, '-')))
    .filter((project) => existsSync(project))
  const dirs = []
  for (const project of projects)
    for (const session of readdirSync(project)) {
      const workflows = join(project, session, 'subagents', 'workflows')
      if (!existsSync(workflows)) continue
      for (const run of readdirSync(workflows)) {
        const dir = join(workflows, run)
        if (statSync(dir).isDirectory()) dirs.push({ dir, at: statSync(dir).mtimeMs })
      }
    }
  return dirs.sort((a, b) => b.at - a.at).map((d) => d.dir)
}

const dir =
  arg('dir') ?? (process.argv.includes('--latest') ? workflowDirs()[0] : undefined)
// --peek: print what the run has used so far and write nothing (the loop checks
// its spend before each fix round).
const peek = process.argv.includes('--peek')
if (!dir || !existsSync(dir)) {
  console.error('No workflow transcript folder found. Pass --dir or --latest.')
  process.exit(1)
}

const labels = {}
const journal = join(dir, 'journal.jsonl')
if (existsSync(journal))
  for (const line of readFileSync(journal, 'utf8').split('\n')) {
    try {
      const e = JSON.parse(line)
      if (e.agentId && e.label) labels[e.agentId] = e.label
    } catch {
      // a partial line
    }
  }

const agents = []
for (const file of readdirSync(dir).filter((f) => /^agent-.*\.jsonl$/.test(f))) {
  const id = basename(file, '.jsonl').slice(6)
  const a = {
    label: labels[id] ?? id,
    model: '',
    turns: 0,
    tools: 0,
    context: 0,
    output: 0,
  }
  for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
    let e
    try {
      e = JSON.parse(line)
    } catch {
      continue
    }
    const u = e?.message?.usage
    if (e?.type !== 'assistant' || !u) continue
    a.turns += 1
    if (e.message.model)
      a.model = e.message.model.replace(/^claude-/, '').replace(/-\d{8}$/, '')
    a.context +=
      (u.input_tokens ?? 0) +
      (u.cache_read_input_tokens ?? 0) +
      (u.cache_creation_input_tokens ?? 0)
    a.output += u.output_tokens ?? 0
    for (const c of e.message.content ?? []) if (c?.type === 'tool_use') a.tools += 1
  }
  agents.push(a)
}
agents.sort((x, y) => y.context - x.context)

const byRole = {}
for (const a of agents) {
  const role = a.label.split(':')[0]
  byRole[role] ??= { agents: 0, tokens: 0, output: 0, models: {} }
  byRole[role].agents += 1
  byRole[role].tokens += a.context
  byRole[role].output += a.output
  byRole[role].models[a.model || 'unknown'] =
    (byRole[role].models[a.model || 'unknown'] ?? 0) + 1
}
const totals = agents.reduce(
  (t, a) => ({
    context: t.context + a.context,
    output: t.output + a.output,
    turns: t.turns + a.turns,
  }),
  { context: 0, output: 0, turns: 0 },
)

if (peek) {
  console.info(JSON.stringify({ run: basename(dir), agents: agents.length, ...totals }))
  process.exit(0)
}

const m = (n) => `${(n / 1e6).toFixed(1)}M`
const k = (n) => `${Math.round(n / 1e3)}k`
const report = [
  `# Cost: ${slug}`,
  '',
  `Written by scripts/loop/cost.mjs from ${dir.replace(homedir(), '~')}.`,
  '',
  `${agents.length} agents, ${totals.turns} turns, ${m(totals.context)} tokens of context read, ${k(totals.output)} written.`,
  '',
  '| Agent | Model | Turns | Tool calls | Context read | Written |',
  '|---|---|---|---|---|---|',
  ...agents.map(
    (a) =>
      `| ${a.label} | ${a.model || '?'} | ${a.turns} | ${a.tools} | ${m(a.context)} | ${k(a.output)} |`,
  ),
  '',
  '| Role | Agents | Models | Context read | Average per agent |',
  '|---|---|---|---|---|',
  ...Object.entries(byRole).map(
    ([role, r]) =>
      `| ${role} | ${r.agents} | ${Object.entries(r.models)
        .map(([model, n]) => `${model} ${n}`)
        .join(', ')} | ${m(r.tokens)} | ${m(r.tokens / r.agents)} |`,
  ),
  '',
].join('\n')
mkdirSync(join(RUNS_DIR, slug), { recursive: true })
// A slug run more than once keeps every run's section, newest last.
const costPath = join(RUNS_DIR, slug, 'cost.md')
const section = report.replace(`# Cost: ${slug}`, `## Run ${basename(dir)}`)
const before = existsSync(costPath)
  ? readFileSync(costPath, 'utf8')
      .replace(new RegExp(`## Run ${basename(dir)}[\\s\\S]*?(?=\\n## Run |$)`), '')
      .trimEnd()
  : `# Cost: ${slug}`
writeFileSync(costPath, `${before}\n\n${section.trim()}\n`)

const history = existsSync(COSTS_FILE)
  ? JSON.parse(readFileSync(COSTS_FILE, 'utf8'))
  : { runs: [] }
const run = basename(dir)
history.runs = history.runs.filter((r) => r.run !== run)
history.runs.push({ run, slug, at: new Date().toISOString(), totals, byRole })
writeFileSync(COSTS_FILE, JSON.stringify(history, null, 2) + '\n')

console.info(
  JSON.stringify({
    slug,
    run,
    agents: agents.length,
    ...totals,
    report: relative(ROOT, costPath),
  }),
)
