#!/usr/bin/env node
// Copies the build loop into a repository.
//
//   node install.mjs /path/to/your/repo [--force]
//
// Copies the skills, agent types, workflow and scripts, adds the guard hook to
// the repo's .claude/settings.json, and adds .loop/ and .claude/worktrees/ to
// its .gitignore. It never overwrites a file that already exists unless
// --force is given, and lists what it skipped. It writes no settings for the
// project: open Claude Code in the repo and ask it to set up the build loop.
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const target = process.argv[2] && resolve(process.argv[2])
const force = process.argv.includes('--force')
if (!target || !existsSync(join(target, '.git'))) {
  console.error('Usage: node install.mjs /path/to/a/git/repo [--force]')
  process.exit(1)
}

const SOURCES = [
  '.claude/skills/build-loop',
  '.claude/skills/change-spec',
  '.claude/skills/question-research',
  '.claude/skills/screen-design',
  '.claude/skills/screen-verify',
  '.claude/skills/security-check',
  '.claude/skills/tests-judge',
  '.claude/skills/merge-approve',
  '.claude/agents',
  '.claude/workflows',
  'scripts/loop',
]

const files = (path) =>
  statSync(path).isDirectory() ? readdirSync(path).flatMap((name) => files(join(path, name))) : [path]

const copied = []
const skipped = []
for (const source of SOURCES)
  for (const file of files(join(HERE, source))) {
    const rel = relative(HERE, file)
    const dest = join(target, rel)
    if (existsSync(dest) && !force) {
      skipped.push(rel)
      continue
    }
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(file, dest)
    copied.push(rel)
  }

const settingsPath = join(target, '.claude', 'settings.json')
const settings = existsSync(settingsPath) ? JSON.parse(readFileSync(settingsPath, 'utf8')) : {}
const GUARD = 'node "$CLAUDE_PROJECT_DIR/scripts/loop/guard.mjs"'
settings.hooks ??= {}
settings.hooks.PreToolUse ??= []
const wired = settings.hooks.PreToolUse.some((entry) => (entry.hooks ?? []).some((h) => h.command === GUARD))
if (!wired) {
  settings.hooks.PreToolUse.push({ matcher: 'Bash', hooks: [{ type: 'command', command: GUARD }] })
  mkdirSync(dirname(settingsPath), { recursive: true })
  writeFileSync(settingsPath, JSON.stringify(settings, null, 2) + '\n')
}

const ignorePath = join(target, '.gitignore')
const ignore = existsSync(ignorePath) ? readFileSync(ignorePath, 'utf8') : ''
const missing = ['.loop/', '.claude/worktrees/'].filter(
  (line) => !ignore.split('\n').some((l) => l.trim() === line || l.trim() === line.replace(/\/$/, '')),
)
if (missing.length)
  writeFileSync(ignorePath, `${ignore}${ignore && !ignore.endsWith('\n') ? '\n' : ''}\n# build loop\n${missing.join('\n')}\n`)

console.info(`Copied ${copied.length} files into ${target}.`)
if (skipped.length)
  console.info(`Skipped ${skipped.length} that already exist (pass --force to overwrite):\n${skipped.map((f) => `  ${f}`).join('\n')}`)
console.info(wired ? 'The guard hook was already in .claude/settings.json.' : 'Added the guard hook to .claude/settings.json.')
if (missing.length) console.info(`Added ${missing.join(' and ')} to .gitignore.`)
console.info('\nNext: open Claude Code in the repo and say "set up the build loop".')
