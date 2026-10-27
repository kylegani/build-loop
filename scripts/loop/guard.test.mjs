// Tests for the guard hook and the command matching behind it.
//   node --test scripts/loop/guard.test.mjs
import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { describe, it } from 'node:test'
import { fileURLToPath } from 'node:url'
import { invokesForbidden, invokesHeavy, invokesOutward, loopConfig, segments } from './lib/loop-config.mjs'

const GUARD = fileURLToPath(new URL('./guard.mjs', import.meta.url))
const config = {
  ...loopConfig(),
  heavyCommands: [...loopConfig().heavyCommands, 'npm run build', 'pnpm test:e2e'],
  forbiddenCommands: [...loopConfig().forbiddenCommands, 'terraform apply'],
}

function guard(command, role, call = { agent_id: 'a1' }) {
  const result = spawnSync('node', [GUARD, ...(role ? [role] : [])], {
    input: JSON.stringify({ ...call, tool_input: { command } }),
    encoding: 'utf8',
  })
  return { allowed: result.status === 0, message: result.stderr }
}

describe('segments', () => {
  it('splits a command into the programs it runs, without runners or env assignments', () => {
    assert.deepEqual(segments('FOO=1 pnpm exec playwright test && node scripts/loop/checks.mjs | tail'), [
      'playwright test',
      'scripts/loop/checks.mjs',
      'tail',
    ])
  })

  it('reads the same program through any package manager or language runner', () => {
    for (const command of ['npx playwright test', 'yarn playwright test', 'bunx playwright test', 'pnpm dlx playwright test'])
      assert.deepEqual(segments(command), ['playwright test'], command)
    assert.deepEqual(segments('uv run pytest -x'), ['pytest -x'])
    assert.deepEqual(segments('bundle exec rspec'), ['rspec'])
    assert.deepEqual(segments('npm run build'), ['build'])
  })
})

describe('what counts as heavy, outward or forbidden', () => {
  it('reads a command that only mentions a heavy program as light', () => {
    assert.equal(invokesHeavy('grep -n "playwright test" docs/x.md', config), false)
    assert.equal(invokesHeavy('cat scripts/loop/checks.mjs', config), false)
    assert.equal(invokesHeavy('npx playwright test --project=billing', config), true)
    assert.equal(invokesHeavy('pnpm build', config), true)
    assert.equal(invokesHeavy('yarn test:e2e', config), true)
    assert.equal(invokesHeavy('node scripts/loop/shoot.mjs --routes "/ as admin"', config), true)
  })

  it('treats pushes, merges and comments as outward, and reading checks as not', () => {
    assert.equal(invokesOutward('git push origin loop/x', config), true)
    assert.equal(invokesOutward('gh pr merge 12 --merge', config), true)
    assert.equal(invokesOutward('node scripts/loop/ship.mjs revert --slug x', config), true)
    assert.equal(invokesOutward('node scripts/loop/ship.mjs pr --slug x', config), false)
    assert.equal(invokesOutward('gh pr checks 12', config), false)
  })

  it('forbids protected branches, force pushes, throwing work away and listed commands', () => {
    for (const command of [
      'git push origin HEAD:main',
      'git push origin master',
      'git push --force origin loop/x',
      'git push -f origin loop/x',
      'git stash',
      'git reset --hard origin/main',
      'gh pr create --base main --head loop/x',
      'git checkout main',
      'terraform apply -auto-approve',
    ])
      assert.equal(invokesForbidden(command, config), true, command)
    assert.equal(invokesForbidden('git push --set-upstream origin loop/x', config), false)
    assert.equal(invokesForbidden('git checkout -b loop/maintenance', config), false)
  })
})

describe('the guard hook', () => {
  it('never blocks the main session', () => {
    assert.equal(guard('git stash', undefined, {}).allowed, true)
  })

  it('refuses polling loops from any subagent', () => {
    assert.equal(guard('until gh run view 1; do sleep 30; done', undefined, { agent_id: 'x' }).allowed, false)
  })

  it('keeps heavy work to the roles that may start it', () => {
    assert.equal(guard('npx playwright test', 'loop-builder').allowed, false)
    assert.equal(guard('npx playwright test', 'loop-gate').allowed, true)
    assert.equal(guard('node scripts/loop/checks.mjs --base origin/main', 'loop-runner').allowed, true)
  })

  it('lets only the approver push, merge or comment', () => {
    assert.equal(guard('gh pr merge 3 --merge', 'loop-fixer').allowed, false)
    assert.equal(guard('gh pr merge 3 --merge', 'loop-approver').allowed, true)
    assert.equal(guard('gh pr comment 3 --body-file x', 'loop-gate').allowed, false)
  })

  it('refuses a protected branch even to the approver', () => {
    const result = guard('git push origin HEAD:main', 'loop-approver')
    assert.equal(result.allowed, false)
    assert.match(result.message, /protected branch/)
  })

  it('lets only integrators, fixers and the approver commit', () => {
    assert.equal(guard('git add -A && git commit -m "feat(x): y"', 'loop-builder').allowed, false)
    assert.equal(guard('git add -A && git commit -m "feat(x): y"', 'loop-integrator').allowed, true)
  })
})
