#!/usr/bin/env node
// The build loop's run controller. A workflow script can't touch the file
// system, so the loop's runner agent calls this at the start and end of a run
// and after each wave. It prints JSON.
//
//   worktree  --slug s                     make (or reuse) the run's worktree on
//                                          <branchPrefix><slug> off origin/<baseBranch>;
//                                          the lead enters it before starting the workflow
//   start     --slug s --run r [--planned '{"builder":5,"gate":6}']
//             take the run lock (refused while another run's heartbeat is
//             fresh), clear a stop, read the settings, what earlier runs of
//             this slug finished, the newest lessons, and estimate the cost
//   heartbeat --run r                      keep the lock fresh
//   state     --slug s --json '{...}'      record task results (merged)
//   save      --slug s --name report.md    write stdin to a file in the run folder
//   usage                                  what the running run has read so far
//   stop      [--reason "..."]             ask every agent to wind down
//   finish    --slug s --run r [--dir d]   kill what the run's agents left running,
//                                          release locks, write the cost report
import { execFileSync, execSync } from 'node:child_process'
import { copyFileSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import {
  COSTS_FILE,
  HEAVY_LOCK,
  LESSONS_FILE,
  LOOP_DIR,
  MAIN_ROOT,
  ROOT,
  RUNS_DIR,
  RUN_LOCK,
  STOP_FILE,
  WORKTREES_DIR,
  alive,
  isHeavy,
  loopConfig,
} from './lib/loop-config.mjs'

const [command, ...rest] = process.argv.slice(2)
const opt = (name) => {
  const i = rest.indexOf(`--${name}`)
  return i === -1 ? undefined : rest[i + 1]
}
const out = (value) => {
  console.info(JSON.stringify(value, null, 2))
  process.exit(0)
}
const readJson = (path, fallback) =>
  existsSync(path) ? JSON.parse(readFileSync(path, 'utf8')) : fallback
mkdirSync(LOOP_DIR, { recursive: true })

const statePath = (slug) => join(RUNS_DIR, slug, 'state.json')
const lessons = () =>
  existsSync(LESSONS_FILE)
    ? readFileSync(LESSONS_FILE, 'utf8')
        .split('\n')
        .filter((l) => l.startsWith('- '))
        .slice(-20)
    : []

/** Average context tokens per agent of each role, from the last three runs that had it. */
function estimate(planned) {
  const history = readJson(COSTS_FILE, { runs: [] }).runs
  const recent = {}
  for (const run of [...history].reverse())
    for (const role of Object.keys(run.byRole ?? {}))
      if ((recent[role] = recent[role] ?? []).length < 3) recent[role].push(run)
  const per = {}
  for (const [role, runs] of Object.entries(recent))
    for (const run of runs) {
      per[role] ??= { tokens: 0, agents: 0 }
      per[role].tokens += run.byRole[role].tokens
      per[role].agents += run.byRole[role].agents
    }
  let total = 0
  const lines = []
  for (const [role, count] of Object.entries(planned ?? {})) {
    const avg = per[role]?.agents ? per[role].tokens / per[role].agents : null
    if (avg === null) {
      lines.push(`${role}: ${count} agents, no history yet`)
      continue
    }
    total += avg * count
    lines.push(`${role}: ${count} agents at about ${Math.round(avg / 1e6)}M each`)
  }
  return { tokens: Math.round(total), lines }
}

const git = (args, cwd = ROOT) =>
  execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim()

if (command === 'usage') {
  try {
    out(
      JSON.parse(
        execFileSync('node', [join(ROOT, 'scripts/loop/cost.mjs'), '--latest', '--peek'], {
          encoding: 'utf8',
        }),
      ),
    )
  } catch (error) {
    out({ context: 0, error: String(error.message).slice(0, 200) })
  }
}

if (command === 'worktree') {
  const config = loopConfig()
  const slug = opt('slug')
  if (!slug || !/^[\w.-]+$/.test(slug))
    out({ ok: false, reason: 'Pass --slug with letters, digits, dots, dashes or underscores only.' })
  const path = join(WORKTREES_DIR, `loop-${slug}`)
  const branch = `${config.branchPrefix}${slug}`
  if (!existsSync(path)) {
    try {
      git(['fetch', 'origin', config.baseBranch, '--quiet'], MAIN_ROOT)
      const exists = git(['branch', '--list', branch], MAIN_ROOT) !== ''
      git(
        [
          'worktree',
          'add',
          ...(exists ? [path, branch] : ['-b', branch, path, `origin/${config.baseBranch}`]),
        ],
        MAIN_ROOT,
      )
    } catch (error) {
      out({
        ok: false,
        reason: `git worktree add failed: ${String(error.stderr ?? error.message).slice(0, 300)}`,
      })
    }
  }
  // Untracked files the tests and servers read (env files) don't come with a
  // worktree.
  for (const file of config.worktree.copyFiles ?? [])
    if (existsSync(join(MAIN_ROOT, file)) && !existsSync(join(path, file))) {
      mkdirSync(dirname(join(path, file)), { recursive: true })
      copyFileSync(join(MAIN_ROOT, file), join(path, file))
    }
  if (config.worktree.install) {
    try {
      execSync(config.worktree.install, { cwd: path, stdio: 'pipe' })
    } catch (error) {
      out({
        ok: false,
        reason: `${config.worktree.install} failed in ${path}: ${String(error.stderr ?? error.message).slice(-300)}`,
      })
    }
  }
  out({
    ok: true,
    path,
    branch,
    next: 'Enter it (EnterWorktree with this path), then run the workflow by scriptPath from there.',
  })
}

if (command === 'start') {
  // The loop's own scripts must parse: a broken edit stops a run here, not at
  // teardown.
  for (const file of ['run.mjs', 'guard.mjs', 'context.mjs', 'cost.mjs', 'checks.mjs', 'ship.mjs', 'shoot.mjs']) {
    try {
      execFileSync('node', ['--check', join(ROOT, 'scripts/loop', file)], { stdio: 'pipe' })
    } catch (error) {
      out({
        ok: false,
        reason: `scripts/loop/${file} doesn't parse: ${String(error.stderr ?? error.message).slice(0, 300)}`,
      })
    }
  }
  const slug = opt('slug')
  const run = opt('run')
  const config = loopConfig()
  if (!config.configured)
    out({
      ok: false,
      reason: `${relative(ROOT, join(ROOT, '.claude/workflows/loop.config.json'))} doesn't exist. Run the build-loop skill's setup first.`,
    })
  // A run changes files, commits and pushes, so it only ever works on its own
  // branch in its own worktree, never in the maintainer's checkout.
  let branch = ''
  try {
    branch = git(['rev-parse', '--abbrev-ref', 'HEAD'])
  } catch {
    branch = ''
  }
  if (branch !== `${config.branchPrefix}${slug}`)
    out({
      ok: false,
      reason: `The loop runs on branch ${config.branchPrefix}${slug} in its own worktree, and this checkout is on "${branch}". Run node scripts/loop/run.mjs worktree --slug ${slug}, enter the path it prints, and start the workflow from there.`,
    })
  const lock = readJson(RUN_LOCK, null)
  if (lock && lock.run !== run) {
    const age = (Date.now() - Date.parse(lock.heartbeat)) / 60000
    if (age < config.abandonedLockMinutes)
      out({
        ok: false,
        reason: `Run ${lock.run} (${lock.slug}) holds the loop, last heartbeat ${Math.round(age)} minutes ago. One run at a time: wait for it, or stop it with node scripts/loop/run.mjs stop.`,
      })
  }
  const now = new Date().toISOString()
  writeFileSync(RUN_LOCK, JSON.stringify({ run, slug, started: now, heartbeat: now }))
  rmSync(STOP_FILE, { force: true })
  const state = readJson(statePath(slug), { tasks: {} })
  const done = Object.entries(state.tasks)
    .filter(([, t]) => t.status === 'done')
    .map(([id]) => id)
  const cost = estimate(opt('planned') ? JSON.parse(opt('planned')) : {})
  const { configured, ...settings } = config
  out({
    ok: true,
    config: settings,
    done,
    openFollowUps: state.followUps ?? [],
    // Task bodies only while they are short: an agent relays this output word
    // for word. Longer pending lists are passed by the lead as args.tasks.
    pendingTasks:
      JSON.stringify(state.pendingTasks ?? []).length <= 4000 ? (state.pendingTasks ?? []) : [],
    pendingTaskIds: (state.pendingTasks ?? []).map((t) => t.id),
    lessons: lessons(),
    estimate: { ...cost, overBudget: cost.tokens > config.budgetTokens },
  })
}

if (command === 'heartbeat') {
  const lock = readJson(RUN_LOCK, null)
  if (lock && lock.run === opt('run'))
    writeFileSync(RUN_LOCK, JSON.stringify({ ...lock, heartbeat: new Date().toISOString() }))
  out({ ok: true, stopped: existsSync(STOP_FILE) })
}

if (command === 'state') {
  const slug = opt('slug')
  const path = statePath(slug)
  const state = readJson(path, { tasks: {} })
  const update = JSON.parse(opt('json') ?? '{}')
  Object.assign(state.tasks, update.tasks ?? {})
  if (update.followUps) state.followUps = update.followUps
  if (update.pendingTasks) state.pendingTasks = update.pendingTasks
  state.updated = new Date().toISOString()
  mkdirSync(join(RUNS_DIR, slug), { recursive: true })
  writeFileSync(path, JSON.stringify(state, null, 2) + '\n')
  const lock = readJson(RUN_LOCK, null)
  if (lock) writeFileSync(RUN_LOCK, JSON.stringify({ ...lock, heartbeat: new Date().toISOString() }))
  out({ ok: true, path: relative(ROOT, path), stopped: existsSync(STOP_FILE) })
}

if (command === 'save') {
  // An agent pipes a run file's text in:
  // node scripts/loop/run.mjs save --slug s --name report.md <<'EOF' ... EOF
  const slug = opt('slug')
  const name = (opt('name') ?? '').replace(/[^\w.-]/g, '')
  let text = ''
  for await (const chunk of process.stdin) text += chunk
  mkdirSync(join(RUNS_DIR, slug), { recursive: true })
  writeFileSync(join(RUNS_DIR, slug, name), text.trim() + '\n')
  out({ ok: true, path: relative(ROOT, join(RUNS_DIR, slug, name)), chars: text.length })
}

if (command === 'stop') {
  writeFileSync(STOP_FILE, JSON.stringify({ at: new Date().toISOString(), reason: opt('reason') ?? '' }))
  out({ ok: true, note: "Every subagent's next command will be refused. Run finish once they are idle." })
}

if (command === 'finish') {
  const slug = opt('slug')
  const run = opt('run')
  const config = loopConfig()
  // Processes the run's agents left behind: heavy commands whose nearest
  // Claude ancestor is this session's. A server the person started in their
  // own terminal, or another session's, is never touched.
  const rows = execFileSync('ps', ['-axo', 'pid=,ppid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim().match(/^(\d+)\s+(\d+)\s+(.*)$/))
    .filter(Boolean)
    .map(([, pid, ppid, cmd]) => ({ pid: Number(pid), ppid: Number(ppid), cmd }))
  const byPid = new Map(rows.map((r) => [r.pid, r]))
  const nearestClaude = (pid) => {
    for (let r = byPid.get(pid), hops = 0; r && hops < 30; r = byPid.get(r.ppid), hops++)
      if (/(^|\/)claude(\s|$)/.test(r.cmd)) return r.pid
    return null
  }
  const ownClaude = nearestClaude(process.ppid)
  const fromClaude = (row) => ownClaude !== null && nearestClaude(row.ppid) === ownClaude
  // Never this process or the shell that started it: a command line that only
  // mentions a heavy command would otherwise match.
  const ancestors = new Set()
  for (let r = byPid.get(process.pid), hops = 0; r && hops < 30; r = byPid.get(r.ppid), hops++)
    ancestors.add(r.pid)
  const killed = []
  for (const row of rows) {
    if (ancestors.has(row.pid)) continue
    const polling = /\b(until|while)\b.*\bdo\b.*\bsleep\b/.test(row.cmd)
    if ((isHeavy(row.cmd, config) || polling) && fromClaude(row)) {
      try {
        process.kill(row.pid, 'SIGTERM')
        killed.push(`${row.pid} ${row.cmd.slice(0, 80)}`)
      } catch {
        // already gone
      }
    }
  }
  const heavy = readJson(HEAVY_LOCK, null)
  if (heavy && !alive(heavy.pid)) rmSync(HEAVY_LOCK, { force: true })
  const lock = readJson(RUN_LOCK, null)
  if (lock && lock.run === run) rmSync(RUN_LOCK, { force: true })
  rmSync(STOP_FILE, { force: true })
  let cost = null
  try {
    cost = JSON.parse(
      execFileSync(
        'node',
        [join(ROOT, 'scripts/loop/cost.mjs'), '--slug', slug, ...(opt('dir') ? ['--dir', opt('dir')] : ['--latest'])],
        { encoding: 'utf8' },
      ),
    )
  } catch (error) {
    cost = { error: String(error.message).slice(0, 200) }
  }
  out({ ok: true, killed, cost })
}

console.error(`Unknown command "${command}". See the comment at the top of scripts/loop/run.mjs.`)
process.exit(1)
