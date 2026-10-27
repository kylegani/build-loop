#!/usr/bin/env node
// The build loop's script checks. Runs every deterministic check in the
// settings (`checks`) on the run's worktree before any gate agent reads a
// line, and prints one JSON result. A failure goes straight to a fixer with
// its error text; gate agents only judge what a script can't.
//
//   node scripts/loop/checks.mjs --base origin/main [--only typecheck,lint]
//
// Each check is { name, command, when?, files? }:
//   when   a pattern; the check runs only when a changed path matches it
//   files  a pattern; the changed paths that match replace {files} in the
//          command, and the check is skipped when none do
// Prints { ok, failures: [{ check, output }], passed: [check], skipped: [check] }.
import { spawnSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { takeHeavyLock } from './lib/heavy-lock.mjs'
import { ROOT, loopConfig } from './lib/loop-config.mjs'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
const config = loopConfig()
const base = arg('base') ?? `origin/${config.baseBranch}`
const only = arg('only')
  ?.split(',')
  .map((s) => s.trim())

takeHeavyLock('the loop check script', { waitMs: 8 * 60 * 1000 })

function sh(command, args) {
  const r = args
    ? spawnSync(command, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 })
    : spawnSync(command, { cwd: ROOT, encoding: 'utf8', shell: true, maxBuffer: 64 * 1024 * 1024 })
  return { status: r.status ?? 1, output: `${r.stdout ?? ''}${r.stderr ?? ''}` }
}
const tail = (text, n = 3000) => (text.length > n ? `...${text.slice(-n)}` : text)
const quote = (path) => `'${path.replace(/'/g, "'\\''")}'`

const names = (text) =>
  text
    .split('\n')
    .map((f) => f.trim())
    .filter((f) => f && existsSync(join(ROOT, f)))
const files = [
  ...new Set([
    ...names(sh('git', ['diff', '--name-only', '--diff-filter=ACMR', `${base}...HEAD`]).output),
    ...names(sh('git', ['ls-files', '--others', '--exclude-standard']).output),
    ...names(sh('git', ['diff', '--name-only', '--diff-filter=ACMR', 'HEAD']).output),
  ]),
]

const failures = []
const passed = []
const skipped = []
for (const check of config.checks) {
  if (only && !only.includes(check.name)) continue
  if (check.when && !files.some((f) => new RegExp(check.when).test(f))) {
    skipped.push(check.name)
    continue
  }
  let command = check.command
  if (check.files) {
    const picked = files.filter((f) => new RegExp(check.files).test(f))
    if (!picked.length) {
      skipped.push(check.name)
      continue
    }
    command = command.replace('{files}', picked.map(quote).join(' '))
  }
  const r = sh(command)
  if (r.status === 0) passed.push(check.name)
  else failures.push({ check: check.name, command, output: tail(r.output) })
}
console.info(
  JSON.stringify(
    {
      ok: failures.length === 0,
      failures,
      passed,
      skipped,
      changedFiles: files.length,
      ...(config.checks.length ? {} : { note: 'No checks are set in loop.config.json.' }),
    },
    null,
    2,
  ),
)
