// Dry run of the build loop with stub agents: no tokens, a few milliseconds.
// Each scenario runs the real build-loop.js with agents that return canned
// results, and checks one behaviour: the agent cap, waves and dependencies,
// previews, research, follow-ups, partial builds, the stop switch, the budget,
// the run lock, audit mode, script checks before gates, one fix round, the
// approver's merge and hand-back rules, and teardown on every exit.
// Run it after every change to build-loop.js (scripts/loop/self-check.mjs does):
//   node .claude/workflows/dry-run.mjs
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

const loop = fileURLToPath(new URL('./build-loop.js', import.meta.url))
const src = readFileSync(loop, 'utf8').replace(/^export const meta/m, 'const meta')

const defaults = Object.fromEntries(
  Object.entries(
    JSON.parse(readFileSync(fileURLToPath(new URL('../../scripts/loop/lib/loop.defaults.json', import.meta.url)), 'utf8')),
  ).filter(([k]) => k !== 'note' && !k.endsWith('Why')),
)
// A project with GitHub CI, screens, a merging approver and two risk areas.
const SETTINGS = {
  ...defaults,
  useAgentTypes: false,
  owner: 'Sam',
  baseBranch: 'develop',
  reading: { ui: [], data: [], api: [], auth: [] },
  ci: { provider: 'github', workflowFile: '.github/workflows/ci.yml', projectPattern: '--project=(\\S+)' },
  screens: { baseUrl: 'http://localhost:3000', roles: { admin: '.auth/admin.json', anonymous: null } },
  approve: { mode: 'merge', smoke: 'npm run smoke' },
  riskPaths: { money: ['billing'], access: ['auth'] },
}
const START = {
  ok: true,
  config: SETTINGS,
  done: [],
  lessons: [],
  estimate: { tokens: 1, overBudget: false },
}
const APPROVED = {
  outcome: 'merged',
  prUrl: 'u',
  mergeSha: 's',
  failures: [],
  tested: ['smoke'],
  notTested: [],
  concerns: [],
}
const built = (id, more = {}) => ({ id, status: 'done', changedFiles: [], notes: 'ok', conventions: [], followUps: [], ...more })
const finding = { severity: 'major', where: 'src/x.ts:4', problem: 'p', evidence: 'e', fix: 'f' }

function stubs(behaviour = {}) {
  const state = { running: 0, peak: 0, calls: [], logs: [], prompts: {}, models: {} }
  let checksRun = 0
  const agent = async (prompt, opts) => {
    state.running += 1
    state.peak = Math.max(state.peak, state.running)
    state.calls.push(opts.label)
    state.prompts[opts.label] = prompt
    state.models[opts.label] = opts.model ?? null
    await new Promise((r) => setTimeout(r, 2 + (prompt.length % 5)))
    state.running -= 1
    const l = opts.label
    const stdout = (value) => ({ stdout: JSON.stringify(value) })
    if (l === 'control:start') return stdout(behaviour.start ?? START)
    if (l.startsWith('control:state')) return stdout({ ok: true, stopped: Boolean(behaviour.stopAfterFirstWave) })
    if (l === 'control:finish') return stdout({ ok: true, killed: [] })
    if (l === 'control:usage') return stdout({ context: behaviour.spent ?? 0 })
    if (l.startsWith('control:checks')) {
      checksRun += 1
      const failing = behaviour.checksFail === 'always' || (behaviour.checksFail === 'once' && checksRun === 1)
      return stdout(
        failing
          ? { ok: false, failures: [{ check: 'typecheck', output: 'error TS2322 in src/x.ts' }], passed: [], skipped: [] }
          : { ok: true, failures: [], passed: ['typecheck'], skipped: [] },
      )
    }
    if (/^control:.*-pr$/.test(l)) return stdout({ ok: true, url: 'https://github.com/x/pull/1', number: 1 })
    if (/^control:.*-ci-\d+$/.test(l)) return stdout({ ok: true, state: behaviour.ci ?? 'pass', failing: [] })
    if (l === 'control:matrix') return stdout({ ok: true, missing: behaviour.missing ?? [] })
    if (l === 'control:risk') return stdout({ ok: true, reasons: behaviour.risk ?? [] })
    if (l.startsWith('recheck:'))
      return {
        gate: l.slice(8),
        pass: !behaviour.stuckGate,
        summary: 'fixed',
        findings: behaviour.stuckGate ? [finding] : [],
        followUps: ['elsewhere'],
      }
    if (l.startsWith('build:')) {
      const id = l.slice(6).replace(/-retry$/, '')
      const custom = behaviour.build?.[id]
      if (typeof custom === 'function') return custom(state)
      return built(id)
    }
    if (l.startsWith('research:'))
      return { doc: `docs/build-loop/research/x/${l.slice(9)}.md`, decision: 'd', sources: ['https://example.com/docs (v1)'] }
    if (l.startsWith('gate:') || l.startsWith('preview:') || l.startsWith('audit:'))
      return {
        gate: l,
        pass: behaviour.failGate !== l && behaviour.stuckGate !== l,
        summary: 's',
        findings: [finding],
      }
    if (l.startsWith('integrate')) return { gate: 'checks', pass: true, summary: 'ok', findings: [] }
    if (l.startsWith('fix')) return { fixed: [], notFixed: [], changedFiles: [] }
    if (l === 'document') return { recorded: [], reportPath: 'r', report: 'r' }
    if (l.startsWith('approve')) return behaviour.approve ? behaviour.approve(l) : APPROVED
    if (l === 'retro') return { lessons: [], proposals: [] }
    return null
  }
  return { state, agent }
}

async function runLoop(args, behaviour) {
  const { state, agent } = stubs(behaviour)
  const parallel = (thunks) => Promise.all(thunks.map((t) => t().catch(() => null)))
  const fn = new Function('args', 'agent', 'parallel', 'phase', 'log', 'budget', 'workflow', `return (async()=>{${src}})()`)
  let out = null
  let error = null
  try {
    out = await fn(args, agent, parallel, () => {}, (m) => state.logs.push(m), {}, null)
  } catch (e) {
    error = e
  }
  return { out, error, ...state }
}

const task = (id, more = {}) => ({
  id,
  title: id,
  brief: id,
  files: [`src/${id}`],
  dependsOn: [],
  areas: ['ui'],
  acceptance: ['a'],
  ui: true,
  readiness: 'bounded',
  ...more,
})
const failures = []
const check = (name, ok) => {
  console.info(`${ok ? 'pass' : 'FAIL'}  ${name}`)
  if (!ok) failures.push(name)
}
const VERIFY = ['build', 'verify']
const ALL = ['build', 'verify', 'document', 'approve']
const withSettings = (more) => ({ start: { ...START, config: { ...SETTINGS, ...more } } })

{
  const r = await runLoop({
    goal: 'g',
    stages: ['build', 'verify', 'document'],
    tasks: ['a', 'b', 'c', 'd'].map((id) => task(id)).concat(task('e', { dependsOn: ['a', 'b', 'c', 'd'] })),
  })
  check('never more than 2 agents at once', r.peak <= 2)
  check('e builds after a to d', r.calls.indexOf('build:e') > r.calls.indexOf('build:d'))
  check('teardown runs', r.calls.includes('control:finish'))
  check('readiness reviewers run', r.calls.includes('gate:readiness-scale') && r.calls.includes('gate:readiness-access'))
  check(
    'every wave is checked and committed by an integrator',
    r.calls.filter((c) => c.startsWith('integrate:wave-')).length >= 2 && /commit/.test(r.prompts['integrate:wave-1']),
  )
  check('the base branch comes from the settings', /origin\/develop/.test(r.prompts['integrate:wave-1']))
  check('the owner is named from the settings', /Sam/.test(r.prompts['build:a']))
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a')] })
  const firstGate = r.calls.findIndex((c) => c.startsWith('gate:'))
  check(
    'scripts run, then CI, then the gate agents',
    r.calls.indexOf('control:checks') < r.calls.indexOf('control:verify-pr') && r.calls.indexOf('control:verify-ci-1') < firstGate,
  )
  check('the api gate is skipped when no task touches the API', !r.calls.includes('gate:api'))
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a')] }, withSettings({ ci: { provider: 'none' } }))
  check(
    'with CI off, nothing is pushed and the tests gate runs the tests itself',
    !r.calls.some((c) => /-pr$|-ci-\d+$|matrix/.test(c)) && /CI is off/.test(r.prompts['gate:tests']),
  )
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a')] }, withSettings({ screens: null }))
  check('a project with no screens runs no UI gate', !r.calls.includes('gate:ui'))
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a', { areas: ['api'], ui: false })] })
  check(
    "the api gate runs when a task touches the API, and the ui gate doesn't without a screen",
    r.calls.includes('gate:api') && !r.calls.includes('gate:ui'),
  )
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a', { projects: ['billing'] })] }, { missing: ['billing'] })
  check("a touched test suite CI doesn't run reaches the tests gate", /billing/.test(r.prompts['gate:tests']))
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a')] }, { ci: 'pending' })
  check(
    'CI is waited on in pieces, then the gates read what finished',
    r.calls.filter((c) => /^control:verify-ci-\d+$/.test(c)).length === 9 && r.logs.some((m) => m.startsWith('CI still running')),
  )
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a')] }, { checksFail: 'once' })
  check(
    'a failing script check goes straight to a fixer, with no gate agent for it',
    r.calls.includes('fix:r1-1') && !r.calls.some((c) => c.startsWith('recheck:')) && /error TS2322/.test(r.prompts['fix:r1-1']),
  )
  check('after the fix the checks and CI run again', r.calls.includes('control:checks-r1') && r.calls.includes('control:fix-r1-pr'))
}
{
  const r = await runLoop({ goal: 'g', stages: ['build'], tasks: [task('shell', { designRisk: true }), task('list')] })
  check('a risky task is built and previewed before anything else', r.calls.indexOf('preview:shell') < r.calls.indexOf('build:list'))
}
{
  const r = await runLoop({
    goal: 'g',
    stages: ['build'],
    tasks: [
      task('helper'),
      task('index'),
      task('other'),
      task('pattern', { designRisk: true, dependsOn: ['helper', 'index'] }),
      task('copy', { dependsOn: ['pattern'] }),
    ],
  })
  check(
    "a risky task's prerequisites build first, then it is previewed, then the rest",
    r.calls.includes('build:helper') &&
      r.calls.indexOf('preview:pattern') > r.calls.indexOf('build:index') &&
      r.calls.indexOf('preview:pattern') < r.calls.indexOf('build:copy') &&
      r.calls.indexOf('preview:pattern') < r.calls.indexOf('build:other'),
  )
}
{
  const r = await runLoop({
    goal: 'g',
    stages: ['research', 'build'],
    tasks: [task('a', { research: [{ kind: 'design', question: 'q' }, { kind: 'convention', question: 'q2' }] })],
  })
  check(
    'each research question is answered before the task builds',
    r.calls.indexOf('research:a-1') < r.calls.indexOf('build:a') && r.calls.indexOf('research:a-2') < r.calls.indexOf('build:a'),
  )
  check(
    'framework conventions come from the official docs for the installed version',
    /official documentation/.test(r.prompts['research:a-2']) && /version this repo has installed/.test(r.prompts['research:a-2']),
  )
  check(
    'design research without reference tools falls back to web search',
    /web search for real, shipped products/.test(r.prompts['research:a-1']),
  )
  check(
    'a builder reads its research decisions',
    /--research docs\/build-loop\/research\/x\/a-1\.md,docs\/build-loop\/research\/x\/a-2\.md/.test(r.prompts['build:a']),
  )
}
{
  const r = await runLoop(
    { goal: 'g', stages: ['research'], tasks: [task('a', { research: [{ kind: 'design', question: 'q' }] })] },
    withSettings({ design: { referenceTools: ['mcp__refs__search_screens'] } }),
  )
  check('design research uses the reference tools the machine has', /mcp__refs__search_screens/.test(r.prompts['research:a-1']))
}
{
  const r = await runLoop({ goal: 'g', stages: ['build'], tasks: [] })
  check('a build with nothing to build stops before any agent works', r.error && !r.calls.some((c) => c.startsWith('build:')))
}
{
  const r = await runLoop(
    { goal: 'g', stages: ['build'], tasks: [task('a'), task('b')] },
    { build: { a: () => built('a', { followUps: [{ file: 'elsewhere.ts', change: 'rename x' }] }) } },
  )
  check('a follow-up in an unowned file becomes a task', r.calls.includes('build:follow-1'))
}
{
  const fu = [
    { file: 'lib/x.ts', change: 'rename' },
    { file: 'lib/x.ts', change: 'retype' },
    { file: 'lib/y.ts', change: 'add' },
    { file: 'CONTRIBUTING.md', change: 'record the rule' },
    { file: 'lib/z.ts', change: 'Optional: tidy' },
  ]
  const r = await runLoop({ goal: 'g', stages: ['build'], tasks: [task('a')] }, { build: { a: () => built('a', { followUps: fu }) } })
  check(
    'follow-ups group by folder, docs go to Document, optional ones are notes',
    r.calls.filter((c) => c.startsWith('build:follow')).length === 1 &&
      r.out.docFollowUps.length === 1 &&
      r.out.optionalFollowUps.length === 1,
  )
}
{
  const fu = [{ file: 'tests/x.spec.ts', change: 'Tests gate: run the e2e spec with --repeat-each=3' }]
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a')] }, { build: { a: () => built('a', { followUps: fu }) } })
  check(
    "a follow-up that asks for a gate's measurement goes to that gate, not a builder",
    !r.calls.some((c) => c.startsWith('build:follow')) && /repeat-each/.test(r.prompts['gate:tests']),
  )
}
{
  let tries = 0
  const r = await runLoop(
    { goal: 'g', stages: ['build'], tasks: [task('a')] },
    { build: { a: () => (++tries === 1 ? built('a', { status: 'partial', notes: 'half' }) : built('a')) } },
  )
  check('a partial task is tried again', r.calls.filter((c) => c === 'build:a').length === 2)
}
{
  const r = await runLoop(
    { goal: 'g', stages: ['build'], tasks: [task('a')] },
    { build: { a: () => built('a', { status: 'partial', notes: 'again' }) } },
  )
  check(
    'a task that keeps stopping is tried twice, then blocked',
    r.calls.filter((c) => c === 'build:a').length === 2 && r.logs.some((m) => m.startsWith('Blocked tasks: a')),
  )
}
{
  const r = await runLoop(
    { goal: 'g', stages: VERIFY, tasks: [task('a'), task('b'), task('c', { dependsOn: ['a'] })] },
    { build: { a: () => built('a', { status: 'blocked', notes: 'waits on a decision' }) } },
  )
  check(
    'blocked work leaves the gates to check what was built',
    r.calls.some((c) => c.startsWith('gate:')) &&
      !r.calls.includes('build:c') &&
      r.logs.some((m) => m.startsWith('Verify runs without the blocked work: a, c')),
  )
}
{
  const r = await runLoop({ goal: 'g', stages: ALL, tasks: [task('a'), task('b', { dependsOn: ['a'] })] }, { stopAfterFirstWave: true })
  check(
    'a stop ends the build and skips verify and approval',
    !r.calls.includes('build:b') &&
      !r.calls.some((c) => c.startsWith('gate:') || c.startsWith('approve')) &&
      r.calls.includes('control:finish'),
  )
}
{
  const r = await runLoop(
    { goal: 'g', stages: VERIFY, tasks: [task('a'), task('b'), task('c', { dependsOn: ['a'] })] },
    { spent: 99e6, ...withSettings({ budgetTokens: 40e6 }) },
  )
  check(
    'real spend over budget pauses the build after a wave and leaves verify for later',
    r.calls.includes('build:a') && r.calls.includes('build:b') && !r.calls.includes('build:c') && !r.calls.some((c) => c.startsWith('gate:')),
  )
}
{
  const r = await runLoop(
    { goal: 'g', stages: VERIFY, tasks: ['a', 'b', 'c'].map((id) => task(id)) },
    { start: { ...START, config: { ...SETTINGS, budgetTokens: 40e6 }, estimate: { tokens: 999e6, overBudget: true } } },
  )
  check(
    'a gloomy forecast alone never cuts the build short',
    r.calls.filter((c) => /^build:[abc]$/.test(c)).length === 3 && r.calls.some((c) => c.startsWith('gate:')),
  )
}
{
  const r = await runLoop(
    { goal: 'g', stages: ['build'], tasks: [task('a')] },
    { build: { a: () => built('a', { followUps: [{ file: 'docs/design.md', change: '13px or 14px?', decision: true }] }) } },
  )
  check(
    'a follow-up that needs a decision goes to the lead, not a builder',
    !r.calls.some((c) => c.startsWith('build:follow')) && r.out.decisions.length === 1,
  )
}
{
  const r = await runLoop({ goal: 'g', stages: ['build'], tasks: [task('a'), task('b')] }, { start: { ...START, done: ['a'] } })
  check('a task done in an earlier run is skipped', !r.calls.includes('build:a') && r.calls.includes('build:b'))
}
{
  const r = await runLoop({ goal: 'g', stages: ['build'], tasks: [task('b', { dependsOn: ['a'] })] }, { start: { ...START, done: ['a'] } })
  check('a dependency an earlier run finished counts as met', !r.error && r.calls.includes('build:b'))
}
{
  const r = await runLoop({ goal: 'g', tasks: [task('a')] }, { start: { ok: false, reason: 'held' } })
  check('a held run lock stops the run before any work', r.error && !r.calls.some((c) => c.startsWith('build:')))
}
{
  const r = await runLoop({ goal: 'g', stages: ['audit'] })
  check(
    'audit mode reviews three lenses and plans',
    ['audit:scale', 'audit:access', 'audit:integrity', 'audit:plan'].every((l) => r.calls.includes(l)),
  )
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a')] }, { failGate: 'gate:ui' })
  check(
    "a failed gate's findings go to a fixer, then only a recheck of what it listed",
    r.calls.includes('fix:r1-1') &&
      r.calls.includes('recheck:ui') &&
      r.calls.filter((c) => c === 'gate:ui').length === 1 &&
      !r.calls.includes('recheck:tests'),
  )
  check("a recheck's new problems elsewhere become follow-ups", (r.out.gateFollowUps || []).length === 1)
}
{
  const r = await runLoop({ goal: 'g', stages: VERIFY, tasks: [task('a')] }, { stuckGate: 'gate:ui' })
  check(
    'one fix round, then the lead',
    r.out.fixRounds === 1 && r.calls.filter((c) => c === 'recheck:ui').length === 1 && r.logs.some((m) => /Over to the lead/.test(m)),
  )
}
{
  const r = await runLoop(
    { goal: 'g', stages: VERIFY, tasks: [task('a')] },
    { failGate: 'gate:ui', spent: 99e6, ...withSettings({ budgetTokens: 40e6 }) },
  )
  check(
    'spend over budget stops fix rounds and hands back to the lead',
    !r.calls.some((c) => c.startsWith('fix:')) && r.out.overBudget === true,
  )
}
{
  const r = await runLoop({ goal: 'g', stages: ALL, tasks: [task('a')] })
  check(
    'with every check passing and no risk, the approver merges',
    /Mode: merge/.test(r.prompts.approve) && r.out.approval.outcome === 'merged',
  )
}
{
  const r = await runLoop({ goal: 'g', stages: ALL, tasks: [task('a')] }, withSettings({ approve: { mode: 'hand-back' } }))
  check(
    'in hand-back mode the approver never merges, even when everything passes',
    /Mode: hand-back/.test(r.prompts.approve) && /never merges/.test(r.prompts.approve),
  )
}
{
  const r = await runLoop({ goal: 'g', stages: ALL, tasks: [task('a')] }, withSettings({ ci: { provider: 'none' }, approve: { mode: 'merge' } }))
  check('without GitHub the approver hands back and writes its verdict to the run folder', /Mode: hand-back/.test(r.prompts.approve) && /handback\.md/.test(r.prompts.approve))
}
{
  const r = await runLoop({ goal: 'g', stages: ALL, tasks: [task('a')] }, { risk: ['money: src/billing/x.ts'] })
  check(
    'a change that touches a risk path is handed back, never merged',
    /Mode: hand-back/.test(r.prompts.approve) && /money: src\/billing/.test(r.prompts.approve),
  )
}
{
  const r = await runLoop({ goal: 'g', stages: ALL, tasks: [task('a')] }, { stuckGate: 'gate:security' })
  check(
    'a gate still failing after the fix round is handed back',
    /Mode: hand-back/.test(r.prompts.approve) && /Gate security fails/.test(r.prompts.approve),
  )
}
{
  const r = await runLoop(
    { goal: 'g', stages: ALL, tasks: [task('a')] },
    { build: { a: () => built('a', { followUps: [{ file: 'docs/design.md', change: '13px or 14px?', decision: true }] }) } },
  )
  check('an open decision is handed back', /Mode: hand-back/.test(r.prompts.approve) && /Decision open/.test(r.prompts.approve))
}
{
  const r = await runLoop({ goal: 'g', stages: ALL, tasks: [task('a')] }, { ci: 'fail' })
  check('failing CI is handed back', /Mode: hand-back/.test(r.prompts.approve) && /CI is fail/.test(r.prompts.approve))
}
{
  const failure = { severity: 'blocker', where: 'src/x.ts', problem: '500 after merge', evidence: 'log', fix: 'f' }
  const r = await runLoop(
    { goal: 'g', stages: ALL, tasks: [task('a')] },
    {
      approve: (l) =>
        l === 'approve'
          ? { ...APPROVED, outcome: 'failed-after-merge', failures: [failure] }
          : { ...APPROVED, outcome: 'reverted', concerns: ['still 500'] },
    },
  )
  check(
    'a failure after the merge gets one fix round, then a retest',
    r.calls.includes('fix:rdeployed-1') &&
      r.calls.includes('approve:retest') &&
      r.calls.indexOf('fix:rdeployed-1') < r.calls.indexOf('approve:retest'),
  )
  check(
    'a retest that fails ends reverted, with its concerns',
    r.out.approval.outcome === 'reverted' && /revert/.test(r.prompts['approve:retest']),
  )
}
{
  const r = await runLoop(
    { goal: 'g', stages: ALL, tasks: [task('a')] },
    { approve: (l) => (l === 'approve' ? { ...APPROVED, outcome: 'failed-after-merge' } : { ...APPROVED, outcome: 'reverted' }) },
  )
  check('a failure after the merge with nothing to fix is reverted at once', r.calls.includes('approve:revert') && !r.calls.includes('approve:retest'))
}
{
  const r = await runLoop(
    { goal: 'g', stages: ALL, tasks: [task('a'), task('b', { dependsOn: ['a'] }), task('c')] },
    { build: { a: () => built('a', { status: 'blocked', notes: '' }) } },
  )
  check('work left unbuilt is handed back', /Mode: hand-back/.test(r.prompts.approve) && /Not built: a, b/.test(r.prompts.approve))
}
{
  const r = await runLoop(
    { goal: 'g', stages: ['build'], tasks: [task('a')] },
    {
      build: {
        a: () => {
          throw new Error('boom')
        },
      },
    },
  )
  check('teardown runs even when an agent throws', r.calls.includes('control:finish'))
}
{
  let tries = 0
  const r = await runLoop({ goal: 'g', stages: ['build'], tasks: [task('a')] }, { build: { a: () => (++tries === 1 ? null : built('a')) } })
  check('an agent that returns nothing gets one retry', r.calls.includes('build:a-retry') && r.out.notDone.length === 0)
}
{
  const pending = { id: 'follow-1', title: 'f', brief: 'f', files: ['x.ts'], dependsOn: [], areas: [], acceptance: [], ui: false, readiness: 'r' }
  const r = await runLoop({ goal: 'g', stages: ['build'], tasks: [task('a')] }, { start: { ...START, done: ['a'], pendingTasks: [pending] } })
  check('follow-ups an earlier run recorded are built on resume', r.calls.includes('build:follow-1'))
}
{
  const r = await runLoop({ goal: 'g', stages: ['spec', 'research', 'build', 'verify'], tasks: undefined }, {})
  check('a spec that returns nothing stops the run', Boolean(r.error))
}
{
  const r = await runLoop({
    goal: 'g',
    stages: ['research', 'build', 'verify'],
    tasks: [
      task('screen', { research: [{ kind: 'design', question: 'q' }, { kind: 'convention', question: 'q' }] }),
      task('service', { ui: false, areas: ['data'], files: ['src/notes/service.ts'] }),
      task('charges', { ui: false, areas: ['data'], files: ['src/billing/charge.ts'] }),
    ],
  })
  check('the runner runs on Haiku', r.models['control:start'] === 'haiku')
  check(
    'a builder with a screen runs on Opus, one without on Sonnet',
    r.models['build:screen'] === 'opus' && r.models['build:service'] === 'sonnet',
  )
  check('a builder on a risk path runs on Opus', r.models['build:charges'] === 'opus')
  check(
    'design research runs on Opus, convention research on Sonnet',
    r.models['research:screen-1'] === 'opus' && r.models['research:screen-2'] === 'sonnet',
  )
  check(
    'the UI and security gates run on Opus, the copy gate on Sonnet',
    r.models['gate:ui'] === 'opus' && r.models['gate:security'] === 'opus' && r.models['gate:copy'] === 'sonnet',
  )
  check(
    'readiness reviewers run on Opus, integrators on Sonnet',
    r.models['gate:readiness-access'] === 'opus' && r.models['integrate:wave-1'] === 'sonnet',
  )
}
{
  let tries = 0
  const r = await runLoop(
    { goal: 'g', stages: ['build'], tasks: [task('a', { ui: false, areas: ['data'] })] },
    { build: { a: () => (++tries === 1 ? built('a', { status: 'partial', notes: 'half' }) : built('a')) } },
  )
  check(
    'a Sonnet builder that stops part way is retried on Opus',
    r.calls.filter((c) => c === 'build:a').length === 2 && r.models['build:a'] === 'opus',
  )
}
{
  const r = await runLoop({ goal: 'g', model: 'sonnet', stages: ['build', 'verify'], tasks: [task('a')] })
  check('args.model forces one model for every agent', Object.values(r.models).every((m) => m === 'sonnet'))
}

if (failures.length) {
  console.error(`${failures.length} dry-run check(s) failed.`)
  process.exit(1)
}
console.info('All dry-run checks passed.')
