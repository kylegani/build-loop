#!/usr/bin/env node
// The build loop's link to GitHub and the deployed site. Prints JSON. Every
// wait ends within about 9 minutes, so an agent's command never outlives its
// 10-minute timeout; the workflow calls again while the answer is "pending".
// Needs the gh CLI, signed in, for everything but `risk`.
//
//   pr       --slug s [--title t]   push the run's branch and open (or reuse) its pull request
//   ci       --slug s               the pull request's checks: pending, pass or fail
//   matrix   --projects '["a"]'     which of these test suites CI never runs (ci.workflowFile)
//   risk     --slug s               reasons the change must go to the owner, from the diff alone
//   merge    --slug s               merge the open pull request                      (approver)
//   deploy   --sha x                the deploy run for a merge commit (approve.deployWorkflow)
//   version  --sha x                whether the deployed site serves that commit (approve.versionCheck)
//   revert   --slug s               revert every merge of the run's branch            (approver)
//   comment  --slug s --body-file f comment on the pull request                      (approver)
import { spawnSync } from 'node:child_process'
import { existsSync, readFileSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT, WORKTREES_DIR, loopConfig } from './lib/loop-config.mjs'

const [command, ...rest] = process.argv.slice(2)
const opt = (name) => {
  const i = rest.indexOf(`--${name}`)
  return i === -1 ? undefined : rest[i + 1]
}
const out = (value) => {
  console.info(JSON.stringify(value, null, 2))
  process.exit(0)
}
const fail = (reason) => out({ ok: false, reason })
const config = loopConfig()
const BASE = config.baseBranch
const WAIT_MS = 9 * 60 * 1000
const POLL_MS = 30 * 1000

function sh(cmd, args, options = {}) {
  const r = spawnSync(cmd, args, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, ...options })
  return { status: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }
}
const json = (cmd, args) => {
  const r = sh(cmd, args)
  if (r.status !== 0) throw new Error(`${cmd} ${args.slice(0, 3).join(' ')}: ${r.stderr.slice(0, 300)}`)
  return JSON.parse(r.stdout || 'null')
}
const sleep = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)
const slug = opt('slug')
const branch = slug ? `${config.branchPrefix}${slug}` : undefined
const CONVENTIONAL = /^(feat|fix|perf|refactor|docs|test|build|ci|chore|style|revert)(\([\w./-]+\))?!?: \S/
const SIGNATURE = 'Opened by the build loop.'

if (command !== 'risk' && sh('gh', ['--version']).status !== 0)
  fail('The gh CLI is not installed or not on the PATH.')

function openPr() {
  return json('gh', [
    'pr', 'list', '--head', branch, '--base', BASE, '--state', 'open',
    '--json', 'number,url,headRefOid', '--limit', '1',
  ])[0]
}

if (command === 'pr') {
  if (!slug) fail('Pass --slug.')
  const head = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout
  if (head !== branch) fail(`This checkout is on ${head}, not ${branch}.`)
  const dirty = sh('git', ['status', '--porcelain']).stdout
  if (dirty) fail(`The worktree has uncommitted changes; the integrator commits before a push:\n${dirty.slice(0, 500)}`)
  const push = sh('git', ['push', '--set-upstream', 'origin', branch])
  if (push.status !== 0) fail(`git push failed: ${push.stderr.slice(0, 400)}`)
  let pr = openPr()
  if (!pr) {
    const wanted = opt('title')
    const title =
      wanted && (config.commitStyle !== 'conventional' || CONVENTIONAL.test(wanted))
        ? wanted
        : config.commitStyle === 'conventional'
          ? `chore(loop): ${slug}`
          : `Build loop: ${slug}`
    const body = `${SIGNATURE} The run report is docs/build-loop/runs/${slug}/report.md on this branch.\n\n<!-- build-loop:${slug} -->`
    const created = sh('gh', ['pr', 'create', '--base', BASE, '--head', branch, '--title', title, '--body', body])
    if (created.status !== 0) fail(`gh pr create failed: ${created.stderr.slice(0, 400)}`)
    pr = openPr()
  }
  out({ ok: true, url: pr.url, number: pr.number, sha: pr.headRefOid })
}

if (command === 'ci') {
  if (!slug) fail('Pass --slug.')
  const pr = openPr()
  if (!pr) fail(`No open pull request from ${branch} into ${BASE}.`)
  const started = Date.now()
  for (;;) {
    // gh exits non-zero while checks fail or are pending; its stdout still holds them.
    const r = sh('gh', ['pr', 'checks', String(pr.number), '--json', 'name,state,bucket,link'])
    let checks = []
    try {
      checks = JSON.parse(r.stdout || '[]')
    } catch {
      if (!/no checks reported/i.test(r.stderr)) fail(r.stderr.slice(0, 300))
    }
    const pending = checks.filter((c) => c.bucket === 'pending')
    const failing = checks
      .filter((c) => c.bucket === 'fail' || c.bucket === 'cancel')
      .map((c) => ({ name: c.name, url: c.link }))
    if (checks.length && !pending.length)
      out({ ok: true, state: failing.length ? 'fail' : 'pass', failing, checks: checks.length, sha: pr.headRefOid, url: pr.url })
    if (Date.now() - started > WAIT_MS)
      out({
        ok: true,
        state: checks.length ? 'pending' : 'none',
        pending: pending.map((c) => c.name),
        failing,
        checks: checks.length,
        sha: pr.headRefOid,
        url: pr.url,
        ...(checks.length ? {} : { note: 'No CI checks were reported on the pull request.' }),
      })
    sleep(POLL_MS)
  }
}

if (command === 'matrix') {
  const wanted = JSON.parse(opt('projects') ?? '[]')
  const { workflowFile, projectPattern } = config.ci
  if (!workflowFile || !projectPattern || !existsSync(join(ROOT, workflowFile)))
    out({ ok: true, missing: [], note: 'ci.workflowFile or ci.projectPattern is not set.' })
  const text = readFileSync(join(ROOT, workflowFile), 'utf8')
  const inCi = new Set([...text.matchAll(new RegExp(projectPattern, 'g'))].map((m) => m[1]))
  out({ ok: true, missing: wanted.filter((p) => !inCi.has(p)) })
}

if (command === 'risk') {
  if (!slug) fail('Pass --slug.')
  const files = sh('git', ['diff', '--name-only', `origin/${BASE}...HEAD`]).stdout.split('\n').filter(Boolean)
  const reasons = []
  // Docs and tests change no behaviour, so they never send a change back on their own.
  const code = files.filter(
    (f) =>
      !/^(docs|\.claude|\.github\/ISSUE_TEMPLATE)\//.test(f) &&
      !/(^|\/)(__tests__|tests?|spec|e2e)\//.test(f) &&
      !/\.(test|spec)\.\w+$/.test(f) &&
      !/\.(md|mdx|txt)$/.test(f),
  )
  for (const [area, patterns] of Object.entries(config.riskPaths ?? {})) {
    const hits = code.filter((f) => patterns.some((p) => new RegExp(p, 'i').test(f)))
    if (hits.length)
      reasons.push(`${area}: ${hits.slice(0, 8).join(', ')}${hits.length > 8 ? ` and ${hits.length - 8} more` : ''}`)
  }
  if (config.migrations)
    for (const file of files.filter((f) => new RegExp(config.migrations).test(f) && existsSync(join(ROOT, f)))) {
      const sql = readFileSync(join(ROOT, file), 'utf8')
      const changes = config.dataChangingSql.filter((p) => new RegExp(p, 'i').test(sql))
      if (changes.length) reasons.push(`existing data: ${file} (${changes.join(', ')})`)
    }
  out({ ok: true, reasons, files: files.length })
}

if (command === 'merge') {
  if (!slug) fail('Pass --slug.')
  if (config.approve.mode !== 'merge') fail('approve.mode is not "merge", so the loop never merges.')
  if ((config.protectedBranches ?? []).includes(BASE)) fail(`${BASE} is a protected branch; the loop never merges into it.`)
  const pr = openPr()
  if (!pr) fail(`No open pull request from ${branch} into ${BASE}.`)
  const merged = sh('gh', ['pr', 'merge', String(pr.number), '--merge'])
  if (merged.status !== 0) fail(`gh pr merge failed: ${merged.stderr.slice(0, 400)}`)
  const view = json('gh', ['pr', 'view', String(pr.number), '--json', 'mergeCommit,url,state'])
  out({ ok: view.state === 'MERGED', sha: view.mergeCommit?.oid, url: view.url })
}

if (command === 'deploy') {
  const sha = opt('sha')
  if (!sha) fail('Pass --sha.')
  const workflow = config.approve.deployWorkflow
  if (!workflow) out({ ok: true, state: 'not-set', note: 'approve.deployWorkflow is not set.' })
  const started = Date.now()
  for (;;) {
    const runInfo = json('gh', [
      'run', 'list', '--workflow', workflow, '--branch', BASE, '--commit', sha,
      '--json', 'databaseId,status,conclusion,url', '--limit', '1',
    ])[0]
    if (runInfo && runInfo.status === 'completed')
      out({ ok: true, state: runInfo.conclusion === 'success' ? 'success' : 'failure', runId: runInfo.databaseId, url: runInfo.url })
    if (Date.now() - started > WAIT_MS)
      out({
        ok: true,
        state: runInfo ? runInfo.status : 'missing',
        runId: runInfo?.databaseId,
        url: runInfo?.url,
        note: runInfo ? 'Still running; call again.' : 'No deploy run for this commit yet.',
      })
    sleep(POLL_MS)
  }
}

if (command === 'version') {
  const sha = opt('sha')
  if (!sha) fail('Pass --sha.')
  const check = config.approve.versionCheck
  if (!check) out({ ok: true, state: 'not-set', note: 'approve.versionCheck is not set.' })
  const r = sh('curl', ['-fsS', '--max-time', '30', check.url])
  if (r.status !== 0) fail(`${check.url} didn't answer: ${r.stderr.slice(0, 200)}`)
  const found = r.stdout.match(new RegExp(check.pattern))
  out({
    ok: Boolean(found && found[1] && sha.startsWith(found[1].slice(0, 7))),
    served: found?.[0] ?? null,
    expected: sha.slice(0, 7),
  })
}

if (command === 'revert') {
  if (!slug) fail('Pass --slug.')
  const prs = json('gh', [
    'pr', 'list', '--head', branch, '--base', BASE, '--state', 'merged',
    '--json', 'number,mergeCommit,mergedAt', '--limit', '10',
  ])
  const shas = prs
    .sort((a, b) => b.mergedAt.localeCompare(a.mergedAt))
    .map((p) => p.mergeCommit?.oid)
    .filter(Boolean)
  if (!shas.length) fail(`Nothing from ${branch} was merged into ${BASE}.`)
  const revertBranch = `${branch}-revert`
  const dir = join(WORKTREES_DIR, `loop-${slug}-revert`)
  sh('git', ['fetch', 'origin', BASE, '--quiet'])
  const add = sh('git', ['worktree', 'add', '-B', revertBranch, dir, `origin/${BASE}`])
  if (add.status !== 0) fail(`git worktree add failed: ${add.stderr.slice(0, 300)}`)
  // out() and fail() exit the process, so the temporary worktree is removed
  // before either is called.
  const revert = () => {
    for (const sha of shas) {
      const r = sh('git', ['revert', '--no-edit', '-m', '1', sha], { cwd: dir })
      if (r.status !== 0) return { ok: false, reason: `git revert ${sha} failed: ${r.stderr.slice(0, 300)}` }
    }
    const push = sh('git', ['push', '--set-upstream', 'origin', revertBranch], { cwd: dir })
    if (push.status !== 0) return { ok: false, reason: `git push failed: ${push.stderr.slice(0, 300)}` }
    const title = config.commitStyle === 'conventional' ? `revert(loop): ${slug}` : `Revert build loop run ${slug}`
    const body = `The build loop reverted its own merge of \`${branch}\`: the change failed after merging, and one fix round didn't hold. The concerns are on the original pull request.`
    const created = sh('gh', ['pr', 'create', '--base', BASE, '--head', revertBranch, '--title', title, '--body', body], { cwd: dir })
    if (created.status !== 0) return { ok: false, reason: `gh pr create failed: ${created.stderr.slice(0, 300)}` }
    const pr = json('gh', ['pr', 'list', '--head', revertBranch, '--state', 'open', '--json', 'number,url', '--limit', '1'])[0]
    const merged = sh('gh', ['pr', 'merge', String(pr.number), '--merge'])
    if (merged.status !== 0) return { ok: false, reason: `gh pr merge failed: ${merged.stderr.slice(0, 300)}`, url: pr.url }
    return { ok: true, url: pr.url, reverted: shas }
  }
  let outcome
  try {
    outcome = revert()
  } catch (error) {
    outcome = { ok: false, reason: String(error.message).slice(0, 300) }
  }
  sh('git', ['worktree', 'remove', '--force', dir])
  if (existsSync(dir)) rmSync(dir, { recursive: true, force: true })
  out(outcome)
}

if (command === 'comment') {
  if (!slug) fail('Pass --slug.')
  const file = opt('body-file')
  if (!file || !existsSync(file)) fail("Pass --body-file with the comment's text.")
  const pr =
    openPr() ??
    json('gh', ['pr', 'list', '--head', branch, '--base', BASE, '--state', 'all', '--json', 'number,url', '--limit', '1'])[0]
  if (!pr) fail(`No pull request from ${branch}.`)
  const r = sh('gh', ['pr', 'comment', String(pr.number), '--body-file', file])
  out({ ok: r.status === 0, url: pr.url, error: r.status === 0 ? undefined : r.stderr.slice(0, 300) })
}

console.error(`Unknown command "${command}". See the comment at the top of scripts/loop/ship.mjs.`)
process.exit(1)
