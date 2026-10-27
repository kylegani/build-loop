#!/usr/bin/env node
// Checks the loop itself, before and after any change to it: every loop
// script parses, the dry run passes (the real workflow with stub agents, no
// tokens), and the guard's tests pass.
//
//   node scripts/loop/self-check.mjs
import { spawnSync } from 'node:child_process'
import { readdirSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/loop-config.mjs'

const step = (label, cmd, args) => {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8' })
  if (r.status !== 0) {
    console.error(`FAIL  ${label}\n${`${r.stdout}${r.stderr}`.slice(-3000)}`)
    process.exit(1)
  }
  console.info(`pass  ${label}`)
}

for (const dir of ['scripts/loop', 'scripts/loop/lib'])
  for (const file of readdirSync(join(ROOT, dir)).filter((f) => f.endsWith('.mjs')))
    step(`${dir}/${file} parses`, 'node', ['--check', join(dir, file)])
step('the dry run', 'node', ['.claude/workflows/dry-run.mjs'])
step('the guard tests', 'node', ['--test', 'scripts/loop/guard.test.mjs'])
console.info('The loop is sound.')
