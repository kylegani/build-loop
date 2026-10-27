export const meta = {
  name: 'build-loop',
  description:
    'Spec, research, design and build a change in waves, check it with scripts, CI and review gates, then merge it or hand it back to the owner with concerns',
  whenToUse:
    'Any feature, redesign or cleanup that touches more than a couple of files, and the periodic readiness audit. Make the run its worktree first (node scripts/loop/run.mjs worktree --slug <slug>), enter it, and run this by scriptPath. The build-loop skill explains the stages and the args.',
  phases: [
    { title: 'Preflight', detail: 'run lock, settings, earlier state, lessons, cost estimate' },
    { title: 'Spec', detail: 'goal to decisions and a task graph with readiness answers' },
    {
      title: 'Research',
      detail: 'design, framework conventions, industry practice and vendor behaviour, each from its own kind of source',
    },
    { title: 'Preview', detail: 'new screens built alone and reviewed on screenshots first' },
    { title: 'Build', detail: 'waves of tasks whose dependencies are done and whose files do not overlap' },
    { title: 'Integrate', detail: 'the check script and a commit after each wave' },
    { title: 'Checks', detail: "the project's own checks, run by script" },
    { title: 'CI', detail: 'push the branch, open the pull request, read its checks' },
    { title: 'Verify', detail: 'tests, ui, api, copy, security, docs, readiness' },
    { title: 'Fix', detail: 'one round of fixers grouped by file, then the lead' },
    { title: 'Audit', detail: 'the whole repo against the readiness standard, turned into tasks' },
    { title: 'Document', detail: 'record conventions and write the run report' },
    { title: 'Approve', detail: 'merge and check the deployed site, or hand back to the owner' },
    { title: 'Teardown', detail: 'stop what agents left, release locks, cost report' },
    { title: 'Retro', detail: 'lessons as proposed checks' },
  ],
}

// ---------------------------------------------------------------------------
// The build loop. Settings come from scripts/loop/lib/loop.defaults.json and
// the project's .claude/workflows/loop.config.json through the preflight;
// args override them.
//
// Arguments:
//   goal            what to build, in the user's words (required)
//   slug            the run's name: its branch, worktree and folder under
//                   docs/build-loop/runs/ (default 'change')
//   title           the pull request's title
//   runId           this run's id for the run lock (default the slug)
//   tasks           a ready task graph, which skips the Spec stage
//   context         extra instructions every agent reads; they never relax a rule
//   stages          default spec, research, build, verify, document, approve,
//                   retro; 'audit' runs the readiness audit
//   gates           default tests, ui, api, copy, security, docs, readiness
//   maxFixRounds    default from the settings (1)
//   model, maxParallel, effort, useAgentTypes, turnCap   override the settings
//   allowOverBudget build and fix even when the spend is over budget
//   decisions       decisions the owner made during the work, for the docs gate to chase
// Acceptance statements are tagged [unit], [e2e], [ui], [deployed] or
// [script] for the check that proves them.
// ---------------------------------------------------------------------------
const VERSION = '1.0'
const A = args || {}
if (!A.goal) throw new Error('build-loop needs args.goal')
const SLUG = A.slug || 'change'
const RUN_ID = A.runId || SLUG
const STAGES = A.stages || ['spec', 'research', 'build', 'verify', 'document', 'approve', 'retro']
const has = (s) => STAGES.includes(s)
const GATES = A.gates || ['tests', 'ui', 'api', 'copy', 'security', 'docs', 'readiness']
const RUN_DIR = `docs/build-loop/runs/${SLUG}`
const SPEC_PATH = `${RUN_DIR}/spec.md`
const CI_POLLS = 9
log(`build-loop ${VERSION}: ${SLUG}`)

const RUNNER = {
  type: 'object',
  properties: { stdout: { type: 'string', description: 'The command output, unchanged' } },
  required: ['stdout'],
}

// --- Control: everything that touches files outside an agent's own work goes
// through a script (scripts/loop/run.mjs, checks.mjs, ship.mjs).
let CONFIG = {
  maxParallel: 2,
  effort: 'medium',
  useAgentTypes: false,
  turnCap: 45,
  fixerTurnCap: 60,
  maxFixRounds: 1,
  model: null,
  models: { runner: 'haiku' },
  strongModel: null,
  strongWhen: {},
  budgetTokens: Infinity,
}
const control = async (cmd, label, phaseName, tries = 2) => {
  const r = await agent(
    `Run this command from the repository root and return its whole output, unchanged, as stdout. Do nothing else.\n\n${cmd}`,
    {
      label: `control:${label}`,
      phase: phaseName || (label === 'start' ? 'Preflight' : label === 'finish' ? 'Teardown' : 'Build'),
      schema: RUNNER,
      effort: 'low',
      ...(A.model || (CONFIG.models && CONFIG.models.runner) ? { model: A.model || CONFIG.models.runner } : {}),
      ...(CONFIG.useAgentTypes && A.useAgentTypes !== false ? { agentType: 'loop-runner' } : {}),
    },
  )
  // A runner that fails (an API error, a false flag) is tried again, then
  // reported as a runner failure, never as something the script said.
  if (!r || !r.stdout)
    return tries > 1
      ? control(cmd, label, phaseName, tries - 1)
      : { ok: false, runnerFailed: true, reason: `The runner agent for "${label}" returned nothing twice.` }
  try {
    return JSON.parse(r.stdout.slice(r.stdout.indexOf('{')))
  } catch {
    return { ok: false, runnerFailed: true, reason: `The runner agent for "${label}" returned output that isn't JSON.` }
  }
}
const quote = (value) => `'${JSON.stringify(value).replace(/'/g, "'\\''")}'`

phase('Preflight')
const planned = { builder: (A.tasks || []).filter((t) => !t.skip).length, gate: GATES.length + 1 }
const pre = await control(
  `node scripts/loop/run.mjs start --slug ${SLUG} --run ${RUN_ID} --planned ${quote(planned)}`,
  'start',
)
if (!pre.ok) throw new Error(pre.reason || 'The preflight failed.')
CONFIG = { ...CONFIG, ...pre.config }
const MODEL = A.model ?? CONFIG.model
const MAX_PARALLEL = Math.max(1, A.maxParallel ?? CONFIG.maxParallel)
const EFFORT = A.effort || CONFIG.effort
const TYPES = A.useAgentTypes ?? CONFIG.useAgentTypes
const TURN_CAP = A.turnCap ?? CONFIG.turnCap
const FIXER_CAP = CONFIG.fixerTurnCap || 60
const MAX_FIX = A.maxFixRounds ?? CONFIG.maxFixRounds ?? 1
const DONE_BEFORE = new Set(pre.done || [])
const OWNER = CONFIG.owner || 'the maintainer'
const BASE = CONFIG.baseBranch || 'main'
const BRANCH = `${CONFIG.branchPrefix || 'loop/'}${SLUG}`
const GITHUB = Boolean(CONFIG.ci && CONFIG.ci.provider === 'github')
const MERGE_MODE = GITHUB && CONFIG.approve && CONFIG.approve.mode === 'merge'
const SCREENS = Boolean(CONFIG.screens)
const AREAS = Object.keys(CONFIG.reading || {})
const DOCS = (CONFIG.projectDocs || []).join(', ') || 'the README and the docs folder'
const TRAILER = CONFIG.commitTrailer ? `, ending with the line "${CONFIG.commitTrailer}"` : ''
const COMMIT_FORM =
  CONFIG.commitStyle === 'conventional'
    ? 'one conventional commit, `type(scope): subject` (feat for a new capability, fix for a correction)'
    : 'one commit with a short subject line'
log(
  `Preflight: ${MAX_PARALLEL} agents at once, effort ${EFFORT}, agent types ${TYPES ? 'on' : 'off'}, CI ${GITHUB ? 'on GitHub' : 'off'}, approve ${MERGE_MODE ? 'merges' : 'hands back'}. ${DONE_BEFORE.size} tasks done in earlier runs. Estimate ${Math.round(((pre.estimate && pre.estimate.tokens) || 0) / 1e6)}M tokens${pre.estimate && pre.estimate.overBudget ? ', over budget' : ''}.`,
)

// --- Schemas -----------------------------------------------------------------
const FOLLOW_UP = {
  type: 'object',
  properties: {
    file: { type: 'string' },
    change: { type: 'string' },
    decision: { type: 'boolean', description: `True when the change needs the lead or ${OWNER} to decide, not a builder` },
  },
  required: ['file', 'change'],
}
const RESEARCH_ITEM = {
  type: 'object',
  properties: {
    kind: { type: 'string', enum: ['design', 'convention', 'practice', 'vendor'] },
    question: { type: 'string' },
  },
  required: ['kind', 'question'],
}
const TASK = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    title: { type: 'string' },
    brief: { type: 'string', description: 'What to build, specific enough to build from' },
    files: { type: 'array', items: { type: 'string' } },
    dependsOn: { type: 'array', items: { type: 'string' } },
    areas: {
      type: 'array',
      items: AREAS.length ? { type: 'string', enum: AREAS } : { type: 'string' },
      description: 'Picks the docs the builder reads (reading in the settings)',
    },
    sections: { type: 'array', items: { type: 'string' }, description: 'Extra doc sections as "path#Heading"' },
    research: { type: 'array', items: RESEARCH_ITEM, description: 'Questions about anything new to the repo' },
    researchDocs: { type: 'array', items: { type: 'string' } },
    designRisk: {
      type: 'boolean',
      description: 'A new screen or a redesign: built alone and reviewed on screenshots before anything builds on it',
    },
    routes: {
      type: 'array',
      items: { type: 'string' },
      description: `Screens that show this task, as "/path as role" (roles: ${Object.keys((CONFIG.screens && CONFIG.screens.roles) || {}).join(', ') || 'none set'})`,
    },
    projects: { type: 'array', items: { type: 'string' }, description: 'Test suites or projects whose tests this task adds or changes' },
    readiness: {
      type: 'string',
      description: `Who sees what, paging, audit records, concurrency, limits, and for a migration what happens to existing data (${CONFIG.readiness})`,
    },
    acceptance: { type: 'array', items: { type: 'string' } },
    ui: { type: 'boolean' },
  },
  required: ['id', 'title', 'brief', 'files', 'dependsOn', 'areas', 'acceptance', 'ui', 'readiness'],
}
const SPEC = {
  type: 'object',
  properties: {
    specPath: { type: 'string' },
    decisions: { type: 'array', items: { type: 'string' } },
    forOwner: { type: 'array', items: { type: 'string' } },
    tasks: { type: 'array', items: TASK },
  },
  required: ['specPath', 'decisions', 'tasks'],
}
const RESEARCH = {
  type: 'object',
  properties: {
    doc: { type: 'string' },
    decision: { type: 'string' },
    sources: { type: 'array', items: { type: 'string' }, description: 'Each source URL with the version it applies to' },
  },
  required: ['doc', 'decision', 'sources'],
}
const BUILD = {
  type: 'object',
  properties: {
    id: { type: 'string' },
    status: {
      type: 'string',
      enum: ['done', 'partial', 'blocked'],
      description: 'partial: stopped at the turn cap; say what is left in notes',
    },
    changedFiles: { type: 'array', items: { type: 'string' } },
    notes: { type: 'string' },
    conventions: { type: 'array', items: { type: 'string' } },
    followUps: { type: 'array', items: FOLLOW_UP, description: 'Changes needed in files this task does not own' },
  },
  required: ['id', 'status', 'changedFiles', 'notes', 'conventions', 'followUps'],
}
const FINDING = {
  type: 'object',
  properties: {
    severity: { type: 'string', enum: ['blocker', 'major', 'minor'] },
    where: { type: 'string', description: 'The file (and line) to change' },
    problem: { type: 'string' },
    evidence: {
      type: 'string',
      description: 'The file and line, query, route and role, log line or screenshot that shows it',
    },
    fix: { type: 'string' },
  },
  required: ['severity', 'where', 'problem', 'evidence', 'fix'],
}
const GATE = {
  type: 'object',
  properties: {
    gate: { type: 'string' },
    pass: { type: 'boolean' },
    summary: { type: 'string' },
    findings: { type: 'array', items: FINDING },
    uncovered: {
      type: 'array',
      items: { type: 'string' },
      description: 'Acceptance statements no test or script checks (tests gate)',
    },
    followUps: {
      type: 'array',
      items: { type: 'string' },
      description: 'On a recheck: new problems on screens or code the fix did not touch',
    },
  },
  required: ['gate', 'pass', 'summary', 'findings'],
}
const FIX = {
  type: 'object',
  properties: {
    fixed: { type: 'array', items: { type: 'string' } },
    notFixed: { type: 'array', items: { type: 'string' } },
    changedFiles: { type: 'array', items: { type: 'string' } },
  },
  required: ['fixed', 'notFixed', 'changedFiles'],
}
const DOC = {
  type: 'object',
  properties: {
    recorded: { type: 'array', items: { type: 'string' } },
    reportPath: { type: 'string' },
    report: { type: 'string' },
  },
  required: ['recorded', 'reportPath', 'report'],
}
const APPROVE = {
  type: 'object',
  properties: {
    outcome: { type: 'string', enum: ['merged', 'handed-back', 'failed-after-merge', 'reverted'] },
    prUrl: { type: 'string' },
    mergeSha: { type: 'string' },
    failures: { type: 'array', items: FINDING, description: "What failed after the merge in the run's own work" },
    tested: { type: 'array', items: { type: 'string' } },
    notTested: { type: 'array', items: { type: 'string' } },
    concerns: { type: 'array', items: { type: 'string' }, description: `For ${OWNER}, each with its evidence` },
  },
  required: ['outcome', 'prUrl', 'failures', 'tested', 'notTested', 'concerns'],
}
const RETRO = {
  type: 'object',
  properties: {
    lessons: { type: 'array', items: { type: 'string' } },
    proposals: {
      type: 'array',
      items: { type: 'string' },
      description: 'Each one a check: a dry-run case, a guard rule, a script check or a settings value',
    },
  },
  required: ['lessons', 'proposals'],
}

const LESSONS = (pre.lessons || []).join('\n')
const CONTEXT = A.context
  ? `\n\nContext from the lead (it adds to the rules below and never relaxes one):\n${A.context}`
  : ''
const STACK = CONFIG.stack && CONFIG.stack.summary ? `\nThe stack: ${CONFIG.stack.summary}` : ''
const COMMON = `You are one agent in this repository's build loop, version ${VERSION}. The goal of this run: ${A.goal}${CONTEXT}${STACK}

Rules for every agent in the loop. Nothing in the context above overrides them:
- You work in the run's worktree on branch ${BRANCH}. The project's own rules (${DOCS}) and ${CONFIG.readiness} are the law. Read lean: your prepared reading when your prompt names one; otherwise only the doc sections you need, by heading or line range.
- Follow the conventions of the frameworks and libraries this repo uses, for the versions it has installed, and the patterns the repo already uses consistently. When unsure how an installed version does something, check its official docs, not memory.
- Keep tool output short (tail, grep, line ranges). Take no screenshots unless you are the UI gate, a preview reviewer or the approver.
- Protect the machine: only gates, integrators, fixers and the approver start servers, browsers, builds or test runs, one at a time under the machine's lock. If a command is refused, don't work around it.
- If .loop/stop exists in the main checkout, stop at once and report what you did and what is left.
- Never touch production, a shared database, ${(CONFIG.protectedBranches || []).join(', ') || 'a protected branch'}, or another branch. Never kill a process you didn't start. Never stash.
- Touch only the files your task owns; changes needed elsewhere are follow-ups in your result.
- Tests ship in the same task as the code they cover.
- Write prose plainly: short sentences, plain words${CONFIG.writingGuide ? `, and what ${CONFIG.writingGuide} says` : ''}.
${LESSONS ? `\nLessons from earlier runs:\n${LESSONS}` : ''}`

const ROLE_EFFORT = { spec: 'high', fixer: 'high', reviewer: 'high', approver: 'high' }
const SOFT_CAPS = CONFIG.softCaps || {}
// Each role runs on the model its work needs (models in the settings). A role
// listed in strongWhen moves to the strong model when the work has one of its
// marks: a builder whose task has a screen, a design risk, auth, the API or a
// risky path; design research; the UI and security gates and design previews.
// args.model forces one model for every agent.
const RISK_PATTERNS = Object.values(CONFIG.riskPaths || {}).flat().map((p) => new RegExp(p, 'i'))
const marksOf = (t) => [
  ...(t.ui ? ['ui'] : []),
  ...(t.designRisk ? ['designRisk'] : []),
  ...(t.areas || []),
  ...((t.files || []).some((f) => RISK_PATTERNS.some((p) => p.test(f))) ? ['risk'] : []),
]
const modelFor = (role, marks = []) => {
  if (MODEL) return MODEL
  const strong = CONFIG.strongModel && (CONFIG.strongWhen[role] || []).some((m) => marks.includes(m))
  return strong ? CONFIG.strongModel : (CONFIG.models || {})[role] || null
}
const run = (role, prompt, opts = {}) => {
  const { marks, ...rest } = opts
  const model = rest.model || modelFor(role, marks)
  return agent(
    `${COMMON}\n\n${prompt}${SOFT_CAPS[role] ? `\n\nStop at about ${SOFT_CAPS[role]} tool calls: return what you have found or done so far, in the schema, and say what is left.` : ''}`,
    {
      ...(model ? { model } : {}),
      effort: ROLE_EFFORT[role] || EFFORT,
      ...(TYPES ? { agentType: `loop-${role}` } : {}),
      ...rest,
    },
  )
}

// Runs fn over items with at most n at once and keeps each result at its
// item's index (null when the agent failed).
async function pool(items, n, fn) {
  const out = new Array(items.length).fill(null)
  let next = 0
  const lane = async () => {
    while (next < items.length) {
      const i = next++
      try {
        out[i] = await fn(items[i], i)
      } catch {
        out[i] = null
      }
    }
  }
  await parallel(Array.from({ length: Math.min(n, items.length) }, () => lane))
  return out
}

const result = {
  version: VERSION,
  tasks: [],
  built: [],
  decisions: [],
  docFollowUps: [],
  optionalFollowUps: [],
  checks: null,
  ci: null,
  gates: [],
  fixRounds: 0,
  followUpsOpen: [],
  approval: null,
  auditTasks: null,
  report: null,
  retro: null,
  stopped: false,
}
let stopped = false
let approval = null

// The check script's failures, one per check, with the error text a fixer
// starts from. A runner failure counts as a failed check, never as a pass.
const runChecks = async (label) => {
  const r = await control(`node scripts/loop/checks.mjs --base origin/${BASE}`, label, 'Checks')
  if (r.runnerFailed) return { ok: false, failures: [{ check: 'runner', output: r.reason }] }
  return r
}
// Pushes the branch and opens (or updates) the pull request, then reads CI
// until it settles. The script waits at most about 9 minutes per call, so a
// long CI run takes several calls. Without GitHub the stage is skipped.
const runCi = async (label) => {
  if (!GITHUB) return { state: 'skipped', failing: [] }
  const pr = await control(
    `node scripts/loop/ship.mjs pr --slug ${SLUG} --title ${quote(A.title || A.goal.slice(0, 90))}`,
    `${label}-pr`,
    'CI',
  )
  if (!pr.ok) return { state: 'error', reason: pr.reason, failing: [] }
  let ci = { state: 'pending' }
  for (let i = 0; i < CI_POLLS && ci.state === 'pending'; i++)
    ci = await control(`node scripts/loop/ship.mjs ci --slug ${SLUG}`, `${label}-ci-${i + 1}`, 'CI')
  if (ci.state === 'pending') log(`CI still running after ${CI_POLLS} waits; the gates read what has finished.`)
  return { ...ci, prUrl: pr.url }
}
const ciPassed = (ci) => Boolean(ci) && (ci.state === 'pass' || ci.state === 'skipped' || ci.state === 'none')

try {
  // --- Audit mode: the whole repo against the readiness standard ----------------
  if (has('audit')) {
    phase('Audit')
    const LENSES = [
      [
        'scale',
        'Data at scale: every list query, endpoint and page; paging with a stable order, silent caps, filtering after the limit, indexes, a query per row, a search index used as the authority.',
      ],
      [
        'access',
        'Access and tenancy: every route against every role, a record from another account or tenant, hidden controls against server refusals, handlers that rely on a parent for auth.',
      ],
      [
        'integrity',
        'Integrity, failure and operations: atomic writes, repeat safety, audit records, webhooks and background jobs, rate limits, migrations, settings read by code but set nowhere, complete screens.',
      ],
    ]
    const found = await pool(LENSES, MAX_PARALLEL, ([lens, scope]) =>
      run(
        'reviewer',
        `Audit the whole repository, not a diff, through the "${lens}" lens, against ${CONFIG.readiness}: ${scope} Report every rule that does not hold, with evidence. Name the rules you checked and found holding in the summary.`,
        { label: `audit:${lens}`, phase: 'Audit', schema: GATE },
      ).then((g) => g && { ...g, gate: lens }),
    )
    const findings = found.filter(Boolean).flatMap((g) => g.findings.map((f) => ({ ...f, lens: g.gate })))
    log(`Audit: ${findings.length} findings`)
    const plan = await run(
      'spec',
      `Turn these readiness audit findings into a task graph that fixes them, following the change-spec skill. Group findings into tasks by the files they touch; every task's files are disjoint from any task that could run beside it. Write it to ${RUN_DIR}/audit.md with the findings table.\n\nFindings:\n${findings.map((f) => `- [${f.severity}, ${f.lens}] ${f.where}: ${f.problem} (${f.evidence}) Fix: ${f.fix}`).join('\n')}`,
      { label: 'audit:plan', phase: 'Audit', schema: SPEC },
    )
    result.auditTasks = plan ? plan.tasks : null
    if (plan && plan.tasks.length)
      await control(
        `node scripts/loop/run.mjs state --slug ${SLUG} --json ${quote({ pendingTasks: plan.tasks, tasks: Object.fromEntries(plan.tasks.map((t) => [t.id, { status: 'pending' }])) })}`,
        'state-audit',
      )
  }

  // --- Spec -------------------------------------------------------------------
  let tasks = A.tasks || null
  if (!tasks && has('spec')) {
    phase('Spec')
    const spec = await run(
      'spec',
      `Use the change-spec skill. Write the spec to ${SPEC_PATH} and return the task graph. Every task answers the readiness questions in \`readiness\` (and, for a migration, what happens to existing data), names its areas${AREAS.length ? ` (${AREAS.join(', ')})` : ''} and any extra doc sections, lists a research question for anything the repo's own docs don't already cover, sets designRisk for a new screen or a redesign, names the screens that show it, and owns files disjoint from any task that could run beside it. Decisions only ${OWNER} can make go in forOwner.`,
      { label: 'spec', phase: 'Spec', schema: SPEC },
    )
    if (!spec) throw new Error('The spec agent returned nothing')
    const thin = spec.tasks.filter((t) => !t.readiness || t.readiness.length < 40)
    if (thin.length) throw new Error(`The spec left the readiness answers thin for: ${thin.map((t) => t.id).join(', ')}`)
    tasks = spec.tasks
    for (const d of spec.forOwner || []) result.decisions.push(`${d} (from the spec)`)
    log(
      `Spec: ${tasks.length} tasks. ${spec.forOwner && spec.forOwner.length ? `For ${OWNER}: ${spec.forOwner.join(' | ')}` : `Nothing waits on ${OWNER}.`}`,
    )
  }
  tasks = tasks || []
  const ids = new Set(tasks.map((t) => t.id))
  for (const t of tasks)
    for (const d of t.dependsOn || [])
      if (!ids.has(d) && !DONE_BEFORE.has(d)) throw new Error(`Task ${t.id} depends on unknown task ${d}`)
  result.tasks = tasks.map((t) => t.id)

  // --- Research ----------------------------------------------------------------
  if (has('research')) {
    const needs = tasks
      .flatMap((t) => (t.research || []).map((r, i) => ({ t, r, i })))
      .filter(({ t, i }) => !DONE_BEFORE.has(t.id) && !(t.researchDocs || [])[i])
    if (needs.length) {
      phase('Research')
      const design = CONFIG.design || {}
      const referenceTools = (design.referenceTools || []).join(', ')
      const SOURCES = {
        design: `${referenceTools ? `the design-reference tools on this machine (${referenceTools}; load them with ToolSearch first)` : 'web search for real, shipped products that do the same job (their public pages, help-centre screenshots and published design systems)'}, plus this project's own best screens${design.exemplars ? ` (${design.exemplars})` : ''}, following the screen-design skill: several searches by the job and by named products, at least three real references compared against what the screen has to do, one chosen with a reason. Take the structure, never the palette: this project's own design docs${(design.docs || []).length ? ` (${design.docs.join(', ')})` : ''} decide how it looks.`,
        convention: `the official documentation of the library, for the version this repo has installed${(CONFIG.officialDocs || []).length ? ` (official sites: ${CONFIG.officialDocs.join(', ')})` : ''}, fetched with WebFetch. A docs tool may help find the page, but cite the official page. Not blog posts, not answers sites, not memory. Check the version the page documents against the manifest and lockfile, and say which version the answer holds for.`,
        practice:
          'web search. Every claim names its source. Prefer standards bodies and the maintainers of the tools involved, and two sources that agree over one that sounds sure.',
        vendor:
          "the vendor's own API documentation, or a fact the repo's docs record as tested. Say plainly when the docs don't settle the question, and what the builder should do then.",
      }
      await pool(needs, MAX_PARALLEL, ({ t, r, i }) =>
        run(
          'researcher',
          `Use the question-research skill (${r.kind}). Question: ${r.question}\n\nIt serves this task: ${t.title}. ${t.brief}\n\nSources: ${SOURCES[r.kind]}\n\nWrite the decision to docs/build-loop/research/${SLUG}/${t.id}-${i + 1}.md with the decision first, then "## Sources", then what you ruled out and why. Return its path.`,
          { label: `research:${t.id}-${i + 1}`, phase: 'Research', schema: RESEARCH, marks: [r.kind] },
        ).then((res) => {
          if (res) (t.researchDocs = t.researchDocs || [])[i] = res.doc
          return res
        }),
      )
    }
  }

  // --- Build -------------------------------------------------------------------
  const done = new Set()
  const blocked = new Set()
  const openFollowUps = []
  let followCount = 0
  const owns = (t, file) => t.files.some((o) => file === o || file.startsWith(o.replace(/\/?$/, '/')))
  const overlap = (a, b) =>
    a.some((f) =>
      b.some((o) => f === o || f.startsWith(o.replace(/\/?$/, '/')) || o.startsWith(f.replace(/\/?$/, '/'))),
    )
  const record = async (wave) => {
    const r = await control(
      `node scripts/loop/run.mjs state --slug ${SLUG} --json ${quote({
        tasks: Object.fromEntries(
          tasks.map((t) => [t.id, { status: done.has(t.id) ? 'done' : blocked.has(t.id) ? 'blocked' : 'pending' }]),
        ),
        followUps: openFollowUps,
        pendingTasks: tasks.filter((t) => !done.has(t.id)),
      })}`,
      `state-${wave}`,
    )
    if (r.stopped) {
      stopped = true
      log('The run was stopped (.loop/stop). Winding down.')
    }
  }

  const fill = (command, files) => command.replace('{files}', files.join(' '))
  const builderChecks = (t) =>
    (CONFIG.builderChecks || []).length
      ? `run these on your files only, once: ${CONFIG.builderChecks.map((c) => `\`${fill(c, t.files)}\``).join(', ')}`
      : 'run the fast checks on your own files only (the linter with fix, the unit tests near them)'
  const buildPrompt = (t) => `Build task "${t.id}": ${t.title}

${t.brief}

You own these files and folders, and only these: ${t.files.join(', ')}
Readiness answers for this task: ${t.readiness || `none given: hold the task to ${CONFIG.readiness}`}
Acceptance:${(t.acceptance || []).map((a) => `\n- ${a}`).join('')}

Start by running \`node scripts/loop/context.mjs --task ${t.id} --areas ${(t.areas || []).join(',') || 'none'} --sections "${(t.sections || []).join(',')}"${(t.researchDocs || []).filter(Boolean).length ? ` --research ${t.researchDocs.filter(Boolean).join(',')}` : ''} --files ${t.files.join(',')}\` and read the file it writes: it replaces reading the docs in full.${(t.researchDocs || []).filter(Boolean).length ? " Follow the research decisions; cite a design decision's chosen reference in the component's doc comment." : ''}${t.ui ? "\nThis task has a screen. Design it yourself with the screen-design skill, from its research decision: name the shape, diff against the project's closest existing screen, climb the surface ladder no higher than needed, and design every state (full, empty, loading, failed). You can't render it; the preview or UI gate will." : ''}
An earlier run may have been cut off part way, so check \`git diff --stat -- <your files>\` and carry on from what is there.
Stop at about ${TURN_CAP} tool calls: if the task isn't finished by then, return status "partial" with what is left in notes.
When the code is written, ${builderChecks(t)}. Don't typecheck the whole project, build or run end-to-end tests: the integrator, the gates and CI do. List every change you need in a file you don't own as a follow-up, marking decision: true on one that needs the lead or ${OWNER} to choose, and every convention you set.`

  // A retry, whether the first attempt returned nothing or stopped part way,
  // runs on the strong model: the cheaper model already had its turn.
  const buildOne = async (t, phaseName) => {
    const escalate = t.partials && CONFIG.strongModel ? { model: MODEL || CONFIG.strongModel } : {}
    const first = await run('builder', buildPrompt(t), {
      label: `build:${t.id}`,
      phase: phaseName,
      schema: BUILD,
      marks: marksOf(t),
      ...escalate,
    })
    if (first) return first
    log(`${t.id} returned nothing; trying once more from what is on disk`)
    const second = await run(
      'builder',
      `${buildPrompt(t)}\n\nAn earlier attempt at this task ended without a result. Start from \`git diff --stat -- <your files>\` and finish what it left.`,
      {
        label: `build:${t.id}-retry`,
        phase: phaseName,
        schema: BUILD,
        marks: marksOf(t),
        ...(CONFIG.strongModel ? { model: MODEL || CONFIG.strongModel } : {}),
      },
    )
    return (
      second || {
        id: t.id,
        status: 'failed',
        changedFiles: [],
        notes: 'Two attempts returned no result.',
        conventions: [],
        followUps: [],
      }
    )
  }

  const absorb = (t, r) => {
    if (r && r.status === 'done') done.add(t.id)
    else if (r && r.status === 'partial' && (t.partials = (t.partials || 0) + 1) < 2)
      t.brief += `\n\nAn earlier attempt stopped at the turn cap. What it said was left: ${r.notes}`
    else blocked.add(t.id)
    if (r) result.built.push({ ...r, id: t.id })
    for (const f of (r && r.followUps) || []) {
      if (f.decision) {
        result.decisions.push(`${f.file}: ${f.change} (from ${t.id})`)
        continue
      }
      const pending = tasks.find((o) => !done.has(o.id) && o.id !== t.id && owns(o, f.file))
      if (pending) pending.brief += `\n\nFollow-up from ${t.id}: ${f.change} (${f.file})`
      else openFollowUps.push({ ...f, from: t.id })
    }
  }

  // Follow-ups become as few tasks as the files allow: optional ones are
  // notes, docs go to the Document stage, a request only a gate can carry out
  // goes to its brief, and the rest group by the task that owns the file,
  // else by folder.
  const isDoc = (file) => /\.mdx?$/.test(file)
  const gateNotes = { tests: [], ui: [] }
  const gateFor = (change) =>
    /screenshot|ui gate|preview/i.test(change)
      ? 'ui'
      : /--repeat-each|e2e|end-to-end|tests gate|in ci\b|test run/i.test(change)
        ? 'tests'
        : null
  const followUpTasks = () => {
    const groups = {}
    for (const f of openFollowUps.splice(0)) {
      if (/^\s*optional/i.test(f.change)) {
        result.optionalFollowUps.push(`${f.file}: ${f.change}`)
        continue
      }
      const gate = gateFor(f.change)
      if (gate) {
        gateNotes[gate].push(`${f.file}: ${f.change} (from ${f.from})`)
        continue
      }
      if (isDoc(f.file)) {
        result.docFollowUps.push(`${f.file}: ${f.change} (from ${f.from})`)
        continue
      }
      const owner = tasks.find((o) => owns(o, f.file))
      const key = owner ? `task:${owner.id}` : f.file.split(/[ ,(]/)[0].split('/').slice(0, -1).join('/') || f.file
      ;(groups[key] = groups[key] || { owner, items: [] }).items.push(f)
    }
    return Object.values(groups).map(({ owner, items }) => {
      followCount += 1
      const files = [...new Set(items.map((f) => f.file.split(/[ ,(]/)[0]))]
      return {
        id: `follow-${followCount}`,
        title: `Follow-ups in ${files.join(', ')}`,
        brief: `Make these changes other builders needed:\n${items.map((f) => `- ${f.file}: ${f.change} (from ${f.from})`).join('\n')}`,
        files,
        dependsOn: [],
        areas: owner ? owner.areas : [],
        sections: owner ? owner.sections : [],
        acceptance: items.map((f) => f.change),
        projects: owner ? owner.projects : [],
        ui: owner ? owner.ui : false,
        readiness: owner ? owner.readiness : 'As the file owner decided.',
      }
    })
  }

  if (has('build')) {
    for (const t of pre.pendingTasks || [])
      if (!ids.has(t.id)) {
        tasks.push(t)
        ids.add(t.id)
      }
    const missing = (pre.pendingTaskIds || []).filter((id) => !ids.has(id) && !DONE_BEFORE.has(id))
    if (missing.length)
      log(
        `The state lists ${missing.length} pending tasks too long to relay (${missing.join(', ')}); pass them as args.tasks to build them.`,
      )
    if (!tasks.length)
      throw new Error(
        `Nothing to build for ${SLUG}: no tasks were passed, the state holds none pending, and the spec stage is off. Pass tasks, or run the spec or audit stage first.`,
      )
    openFollowUps.push(...(pre.openFollowUps || []))
    followCount = tasks.filter((t) => t.id.startsWith('follow-')).length
    for (const t of tasks) if (t.skip || DONE_BEFORE.has(t.id)) done.add(t.id)
    for (const id of DONE_BEFORE) done.add(id)
    let allowance = Infinity
    let wave = 0
    const remaining = () => tasks.filter((t) => !done.has(t.id) && !blocked.has(t.id))
    while (!stopped && remaining().length && allowance > 0) {
      // Risky tasks go first, alone, and only their prerequisites may build
      // before them.
      const risky = remaining().filter((t) => t.designRisk)
      const needed = new Set()
      const visit = (id) => {
        const t = tasks.find((x) => x.id === id)
        for (const d of (t && t.dependsOn) || [])
          if (!needed.has(d)) {
            needed.add(d)
            visit(d)
          }
      }
      for (const t of risky) visit(t.id)
      const depsDone = (t) => (t.dependsOn || []).every((d) => done.has(d))
      const riskyReady = risky.filter(depsDone)
      const ready = remaining().filter(
        (t) => depsDone(t) && (!risky.length || (riskyReady.length ? t.designRisk : needed.has(t.id))),
      )
      if (!ready.length) {
        log(
          `Build stopped: ${remaining()
            .map((t) => t.id)
            .join(', ')} wait on blocked or circular dependencies`,
        )
        break
      }
      wave += 1
      if (riskyReady.length) {
        const t = riskyReady[0]
        log(`Preview: ${t.id}`)
        const r = await buildOne(t, 'Preview')
        allowance -= 1
        if (r && r.status === 'done' && SCREENS) {
          const review = await run(
            'gate',
            `Preview review of task "${t.id}" (${t.title}) before anything builds on it. Use the screen-verify skill on these screens only: ${(t.routes || []).join(', ') || 'the screens it changed'}. Judge it strictly against the project's design docs, the screen-design skill and its research decision. Fix nothing.`,
            { label: `preview:${t.id}`, phase: 'Preview', schema: GATE, marks: ['preview'] },
          )
          if (review && !review.pass)
            await run(
              'fixer',
              `Fix the preview findings for task "${t.id}" in its files (${t.files.join(', ')}):\n${review.findings.map((f) => `- [${f.severity}] ${f.where}: ${f.problem} Fix: ${f.fix}`).join('\n')}\n\nBefore you return, shoot the screens you changed with the screen-verify skill's script and look at them.`,
              { label: `fix:preview-${t.id}`, phase: 'Preview', schema: FIX },
            )
        }
        t.designRisk = false
        absorb(t, r)
      } else {
        const owned = []
        const batch = []
        for (const t of ready) {
          if (batch.length >= allowance) break
          if (!overlap(t.files, owned)) {
            batch.push(t)
            owned.push(...t.files)
          }
        }
        log(`Wave ${wave}: ${batch.map((t) => t.id).join(', ')}`)
        const results = await pool(batch, MAX_PARALLEL, (t) => buildOne(t, 'Build'))
        allowance -= batch.length
        results.forEach((r, i) => absorb(batch[i], r))
      }
      const follows = followUpTasks()
      tasks.push(...follows)
      for (const f of follows) ids.add(f.id)
      phase('Integrate')
      const builtThisWave = result.built
        .slice(-MAX_PARALLEL * 4)
        .filter((b) => b.status === 'done')
        .map((b) => `${b.id}: ${b.notes.slice(0, 160)}`)
      const integration = await run(
        'integrator',
        `Wave ${wave} just finished. Run \`node scripts/loop/checks.mjs --base origin/${BASE}\` once and fix only what fails where the tasks meet (imports, types, shared components, tests that asserted the old behaviour). Then commit everything in the worktree as ${COMMIT_FORM}, with a body that says what the wave built${TRAILER}. Return the check script's result.\n\nBuilt in this wave:\n${builtThisWave.map((b) => `- ${b}`).join('\n') || '- nothing finished'}`,
        { label: `integrate:wave-${wave}`, phase: 'Integrate', schema: GATE },
      )
      if (integration && !integration.pass) log(`Checks after wave ${wave} still failing: ${integration.summary}`)
      await record(wave)
      const spent = await control('node scripts/loop/run.mjs usage', 'usage')
      if (!A.allowOverBudget && spent.context > CONFIG.budgetTokens) {
        log(
          `Build paused: the run has read ${Math.round(spent.context / 1e6)}M tokens against a ${Math.round(CONFIG.budgetTokens / 1e6)}M budget.`,
        )
        allowance = 0
      }
    }
    if (blocked.size) log(`Blocked tasks: ${[...blocked].join(', ')}`)
    if (remaining().length && allowance <= 0)
      log(`Budget reached: ${remaining().length} tasks left for the next run (the same slug resumes them).`)
    result.followUpsOpen = openFollowUps
    result.notDone = tasks
      .filter((t) => !done.has(t.id))
      .map((t) => `${t.id} (${blocked.has(t.id) ? 'blocked' : 'not reached'})`)
  }

  // --- Verify: scripts, then CI, then the gates that need judgement --------------
  const waitsOnBlocked = (t, seen = new Set()) =>
    blocked.has(t.id) ||
    (t.dependsOn || []).some((d) => {
      if (seen.has(d)) return false
      seen.add(d)
      const o = tasks.find((x) => x.id === d)
      return Boolean(o) && !done.has(d) && waitsOnBlocked(o, seen)
    })
  const leftOut = has('build') ? tasks.filter((t) => !done.has(t.id)) : []
  const allBuilt =
    !has('build') || (leftOut.every((t) => waitsOnBlocked(t)) && (!leftOut.length || tasks.some((t) => done.has(t.id))))
  const checked = tasks.filter((t) => !leftOut.includes(t))
  const projects = [...new Set(checked.flatMap((t) => t.projects || []))]
  const uiTasks = checked.filter((t) => t.ui)
  const apiTasks = checked.filter((t) => (t.areas || []).includes('api'))
  const acceptance = checked.flatMap((t) => (t.acceptance || []).map((a) => `${t.id}: ${a}`))
  const checkedBy = (tag) =>
    acceptance.filter((a) => (tag === 'tests' ? !/\[(ui|script|deployed)\]/.test(a) : a.includes(`[${tag}]`)))
  const notesFor = (g) =>
    gateNotes[g] && gateNotes[g].length ? `\nBuilders also asked for:\n${gateNotes[g].map((n) => `- ${n}`).join('\n')}` : ''
  const ciText = () =>
    !GITHUB
      ? `CI is off for this project, so you run the tests yourself under the machine's lock${CONFIG.tests && CONFIG.tests.e2e ? `: \`${CONFIG.tests.e2e}\` for the suites these tasks touch` : ''}.`
      : result.ci
        ? `CI on the pull request: ${result.ci.state}.${(result.ci.failing || []).length ? ` Failing: ${result.ci.failing.map((f) => `${f.name} (${f.url || 'no link'})`).join('; ')}.` : ''}${(result.ci.missingProjects || []).length ? ` Test suites these tasks touch that CI doesn't run: ${result.ci.missingProjects.join(', ')}.` : ''}`
        : 'CI did not run.'
  const GATE_PROMPTS = {
    tests: () =>
      `Gate: tests. Use the tests-judge skill. ${ciText()} Read each failure's log and say whether the app, the test or a known flake is at fault. A test suite these tasks touch that CI doesn't run is a major finding against ${(CONFIG.ci && CONFIG.ci.workflowFile) || 'the CI workflow'}. Then trace every acceptance statement below to the unit or end-to-end test that proves it; list each one nothing checks in \`uncovered\`.\n${checkedBy('tests')
        .map((a) => `- ${a}`)
        .join('\n')}${notesFor('tests')}`,
    ui: () =>
      `Gate: UI. Use the screen-verify skill. Screens this run changed: ${uiTasks.map((t) => `${t.id} (${(t.routes || []).join(', ') || t.title})`).join('; ') || 'none'}. Shoot them at every width and theme the settings name, look at every shot, and report strictly against the project's design docs and the screen-design skill.${
        checkedBy('ui').length ? ` Also judge these statements:\n${checkedBy('ui').map((a) => `- ${a}`).join('\n')}` : ''
      }${notesFor('ui')}`,
    api: () =>
      `Gate: API. These tasks change an API other code or other people depend on: ${apiTasks.map((t) => t.id).join(', ')}. Check every change a client can see: a removed or renamed field, a field whose type or meaning changed, a request field that became required, a changed status code or error shape, a removed route. Each of these breaks existing clients and is a blocker whose fix is a decision for ${OWNER} (a new version, a deprecation period), never a quiet code change. Check new fields and routes are documented the way the repo documents its API, and that any generated API description (an OpenAPI file, a schema, client types) was regenerated rather than edited by hand. ${ciText()}`,
    copy: () =>
      `Gate: copy. Read every sentence this run added or changed that a person reads (git diff origin/${BASE}...HEAD and untracked files: interface text, validation and error messages, emails, docs, API descriptions)${CONFIG.writingGuide ? ` and judge it against ${CONFIG.writingGuide}` : ''}. Look for what a linter can't: vague or inflated wording, jargon the reader wasn't given, the same thing called two names, an error that doesn't say what to do next, placeholder text left in, and text that sounds machine-written. For each finding give the file and line, the problem and the replacement.`,
    security: () => `Gate: security. Use the security-check skill on git diff origin/${BASE}...HEAD and the untracked files.`,
    docs: () =>
      `Gate: docs. Check every convention this run set is written in the doc the project keeps it in (${DOCS}), and that the docs describe the code as it is.${(A.decisions || []).length ? ` ${OWNER} made these decisions during the work; search the project's docs and skills for every statement of the rule each one replaced, and report each one now out of date:\n${A.decisions.map((d) => `- ${d}`).join('\n')}\n` : ''} Conventions builders reported:\n${
        result.built
          .flatMap((b) => b.conventions || [])
          .map((c) => `- ${c}`)
          .join('\n') || '- none'
      }`,
  }
  const READINESS_LENSES = [
    ['scale', 'data at scale (paging, bounded queries, indexes, a query per row, a search index used as the authority)'],
    ['access', 'access and tenancy (every role, another account or tenant, auth in each handler)'],
  ]
  const runGates = async (which) => {
    const active = which
      .filter((g) => g !== 'api' || apiTasks.length)
      .filter((g) => g !== 'ui' || (uiTasks.length && SCREENS))
    const light = active.filter((g) => g !== 'readiness')
    const gate = (g) =>
      run('gate', `${GATE_PROMPTS[g]()} Fix nothing.`, {
        label: `gate:${g}`,
        phase: 'Verify',
        schema: GATE,
        marks: [g],
      }).then((r) => r && { ...r, gate: g })
    const items = [
      ...light.map((g) => () => gate(g)),
      ...(active.includes('readiness')
        ? READINESS_LENSES.map(
            ([lens, scope]) =>
              () =>
                run(
                  'reviewer',
                  `Gate: readiness, through the ${scope} lens. Review the whole feature this run touched (its tasks: ${checked.map((t) => `${t.id}: ${t.files.join(', ')}`).join('; ')}), not only the diff, against ${CONFIG.readiness}. Every finding needs evidence. Fix nothing.`,
                  { label: `gate:readiness-${lens}`, phase: 'Verify', schema: GATE },
                ).then((g) => g && { ...g, gate: `readiness-${lens}` }),
          )
        : []),
    ]
    const results = await pool(items, MAX_PARALLEL, (thunk) => thunk())
    return results.flat().filter(Boolean)
  }
  const failed = (g) => !g.pass || (g.uncovered && g.uncovered.length > 0)
  const recheck = (g) =>
    run(
      'gate',
      `Recheck for gate "${g.gate}". Check only whether each finding below is fixed now${g.gate === 'ui' ? ' (re-shoot only the screens they name)' : g.gate === 'tests' ? ` (${ciText()})` : ''}. Pass when every one is fixed. Anything new you notice on screens or code the fix did not touch goes in followUps, not findings. Fix nothing.\n${g.findings.map((f) => `- [${f.severity}] ${f.where}: ${f.problem}`).join('\n')}${g.uncovered && g.uncovered.length ? `\nAnd these acceptance statements need a test: ${g.uncovered.join('; ')}` : ''}`,
      { label: `recheck:${g.gate}`, phase: 'Verify', schema: GATE, marks: [g.gate] },
    ).then((r) => r && { ...r, gate: g.gate })

  // Findings grouped by the file they change, so each fixer reads one corner
  // of the code; groups with no file in common run side by side.
  const fileOf = (where) => where.split(/[\s:(,]/)[0]
  const fixGroups = (findings) => {
    const groups = {}
    for (const f of findings) (groups[fileOf(f.where)] = groups[fileOf(f.where)] || []).push(f)
    return Object.entries(groups).map(([file, items]) => ({ file, items }))
  }
  const runFixers = async (round, findings, extra) => {
    const groups = fixGroups(findings)
    log(`Fix round ${round}: ${findings.length} findings in ${groups.length} files`)
    return pool(groups, MAX_PARALLEL, (g, i) =>
      run(
        'fixer',
        `Fix round ${round}, ${g.file}:\n${g.items.map((f) => `- [${f.severity}${f.gate ? `, ${f.gate}` : ''}] ${f.where}: ${f.problem} (${f.evidence}) Fix: ${f.fix}`).join('\n')}${extra || ''}\n\nFix every blocker and major finding, and the quick safe minor ones, starting in ${g.file}. If a finding is wrong, say why. Never make a check pass by moving the bar: a change to a budget, baseline, threshold, waiver or test expectation goes in notFixed as a decision for the lead. Don't commit: the loop commits after the round. Stop at about ${FIXER_CAP} tool calls and report what is left.`,
        { label: `fix:r${round}-${i + 1}`, phase: 'Fix', schema: FIX },
      ),
    )
  }
  const commitFixes = (label) =>
    run(
      'integrator',
      `The fix round just finished. Run \`node scripts/loop/checks.mjs --base origin/${BASE}\` once, fix only what fails where the fixes meet, then commit the worktree as ${COMMIT_FORM}${CONFIG.commitStyle === 'conventional' ? ' (usually `fix(scope): subject`)' : ''}${TRAILER}. Return the check script's result.`,
      { label: `integrate:${label}`, phase: 'Fix', schema: GATE },
    )

  if (has('verify') && !stopped) {
    if (!allBuilt) log('Verify skipped: tasks are left to build. Run again with the same slug to finish them, then verify.')
    else {
      if (leftOut.length) log(`Verify runs without the blocked work: ${leftOut.map((t) => t.id).join(', ')}`)
      phase('Checks')
      result.checks = await runChecks('checks')
      phase('CI')
      result.ci = await runCi('verify')
      if (GITHUB && result.ci.state !== 'error') {
        const matrix = await control(`node scripts/loop/ship.mjs matrix --projects ${quote(projects)}`, 'matrix', 'CI')
        result.ci.missingProjects = matrix.missing || []
      }
      phase('Verify')
      result.gates = await runGates(GATES)
      result.gateFollowUps = []
      const checkFindings = () =>
        result.checks && !result.checks.ok
          ? result.checks.failures.map((c) => ({
              severity: 'blocker',
              gate: `check:${c.check}`,
              where: c.file || c.check,
              problem: `${c.check} fails`,
              evidence: (c.output || '').slice(-1500),
              fix: 'Make the check pass without changing what it checks.',
            }))
          : []
      let failing = result.gates.filter(failed)
      while ((failing.length || checkFindings().length) && result.fixRounds < MAX_FIX && !stopped) {
        const spent = await control('node scripts/loop/run.mjs usage', 'usage', 'Fix')
        if (!A.allowOverBudget && spent.context > CONFIG.budgetTokens) {
          log(
            `Fix rounds stopped: the run has read ${Math.round(spent.context / 1e6)}M tokens against a ${Math.round(CONFIG.budgetTokens / 1e6)}M budget. Over to the lead.`,
          )
          result.overBudget = true
          break
        }
        result.fixRounds += 1
        phase('Fix')
        const findings = [
          ...checkFindings(),
          ...failing.flatMap((g) =>
            g.findings.filter((f) => f.severity !== 'minor' || g.findings.length <= 3).map((f) => ({ ...f, gate: g.gate })),
          ),
        ]
        const uncovered = failing.flatMap((g) => g.uncovered || [])
        await runFixers(
          result.fixRounds,
          findings,
          uncovered.length
            ? `\n\nAlso, nothing checks these acceptance statements; add the tests if they are in your file: ${uncovered.join('; ')}`
            : '',
        )
        await commitFixes(`fix-r${result.fixRounds}`)
        phase('Checks')
        result.checks = await runChecks(`checks-r${result.fixRounds}`)
        phase('CI')
        result.ci = {
          ...(await runCi(`fix-r${result.fixRounds}`)),
          missingProjects: (result.ci && result.ci.missingProjects) || [],
        }
        phase('Verify')
        const again = []
        for (const g of failing) again.push(await recheck(g))
        for (const r of again.filter(Boolean)) result.gateFollowUps.push(...(r.followUps || []).map((f) => `${r.gate}: ${f}`))
        result.gates = result.gates.map((g) => again.find((a) => a && a.gate === g.gate) || g)
        failing = result.gates.filter(failed)
      }
      if (failing.length || checkFindings().length)
        log(
          `Still failing after ${result.fixRounds} fix round(s): ${[...failing.map((g) => g.gate), ...checkFindings().map((f) => f.gate)].join(', ')}. Over to the lead.`,
        )
      result.gateFollowUps = [
        ...new Set([...result.gateFollowUps, ...result.gates.flatMap((g) => (g.followUps || []).map((f) => `${g.gate}: ${f}`))]),
      ]
      const carried = [
        ...checkFindings().map((f) => ({ file: f.where, change: `${f.problem}. ${f.evidence.slice(-300)}`, from: f.gate })),
        ...failing.flatMap((g) => g.findings.map((f) => ({ file: f.where, change: `${f.problem} Fix: ${f.fix}`, from: `gate ${g.gate}` }))),
        ...result.gateFollowUps.map((f) => ({ file: 'see the change', change: f, from: 'a gate' })),
      ]
      if (carried.length) {
        await control(`node scripts/loop/run.mjs state --slug ${SLUG} --json ${quote({ followUps: carried })}`, 'state-verify', 'Verify')
        result.carried = carried.length
      }
    }
  }

  // --- Document -----------------------------------------------------------------
  if (has('document') && !stopped) {
    phase('Document')
    result.report = await run(
      'integrator',
      `Close the run. Record every convention, pattern and decision it set in the doc the project keeps it in (${DOCS}), if no one has. Make these documentation changes builders asked for, if they still apply:\n${result.docFollowUps.map((d) => `- ${d}`).join('\n') || '- none'}\nThen write the run report for ${OWNER}: what the run did, what it found, what it suggests, in plain words. Save it by piping the text into \`node scripts/loop/run.mjs save --slug ${SLUG} --name report.md\` with a quoted heredoc, and return the same text as report with reportPath ${RUN_DIR}/report.md. Commit the docs and the run folder as ${CONFIG.commitStyle === 'conventional' ? '`docs(loop): ...`' : 'one commit'}${TRAILER}. Take check results from what is listed here, not from memory.\nChecks: ${result.checks ? (result.checks.ok ? 'pass' : `FAIL: ${result.checks.failures.map((f) => f.check).join(', ')}`) : 'did not run'}\n${ciText()}\nGates:\n${result.gates.map((g) => `- ${g.gate}: ${g.pass ? 'pass' : 'FAIL'}: ${g.summary}`).join('\n') || '- none ran'}\nBuilt:\n${result.built.map((b) => `- ${b.id} (${b.status}): ${b.notes}`).join('\n') || '- nothing'}\nNot done: ${(result.notDone || []).join(', ') || 'none'}\nDecisions for ${OWNER}: ${result.decisions.join('; ') || 'none'}\nOpen follow-ups: ${result.followUpsOpen.map((f) => `${f.file}: ${f.change}`).join('; ') || 'none'}\nFollow-ups from rechecks: ${(result.gateFollowUps || []).join('; ') || 'none'}\nOptional follow-ups (notes, not built): ${result.optionalFollowUps.join('; ') || 'none'}`,
      { label: 'document', phase: 'Document', schema: DOC },
    )
    if (GITHUB && result.ci) result.ci = { ...(await runCi('document')), missingProjects: result.ci.missingProjects || [] }
  }

  // --- Approve: merge and check the deployed site, or hand back -------------------
  if (has('approve') && !stopped && allBuilt) {
    phase('Approve')
    const risk = await control(`node scripts/loop/ship.mjs risk --slug ${SLUG}`, 'risk', 'Approve')
    const reasons = [
      ...(MERGE_MODE ? [] : [`This project's approver never merges (approve.mode is "${(CONFIG.approve && CONFIG.approve.mode) || 'hand-back'}"${GITHUB ? '' : ', and CI is off'}).`]),
      ...(risk.runnerFailed ? [`The risk check didn't run: ${risk.reason}`] : risk.reasons || []),
      ...(result.checks && !result.checks.ok ? [`Checks still fail: ${result.checks.failures.map((f) => f.check).join(', ')}`] : []),
      ...(!ciPassed(result.ci) ? [`CI is ${result.ci ? result.ci.state : 'not run'}`] : []),
      ...result.gates.filter(failed).map((g) => `Gate ${g.gate} fails: ${g.summary}`),
      ...result.decisions.map((d) => `Decision open: ${d}`),
      ...(leftOut.length ? [`Not built: ${leftOut.map((t) => t.id).join(', ')}`] : []),
    ]
    const deployed = acceptance.filter((a) => a.includes('[deployed]'))
    const approvePrompt = (mode, extra) => `Use the merge-approve skill. Mode: ${mode}. ${GITHUB ? `Pull request: ${(result.ci && result.ci.prUrl) || `the open pull request from ${BRANCH} into ${BASE}`}.` : `There is no pull request: write your verdict to ${RUN_DIR}/handback.md with \`node scripts/loop/run.mjs save\`.`}
${mode === 'hand-back' ? `Don't merge. These reasons send the change back to ${OWNER}, and you may add to them but never remove one:\n${reasons.map((r) => `- ${r}`).join('\n')}\nThen write the hand-back.` : ''}${mode === 'merge' ? `Every check and gate passed and the risk check found nothing that needs ${OWNER}. Read the diff once yourself: if you find a reason to hand back that the checks missed (access, money, existing data, a breaking API change, something people would notice that nobody decided), hand back instead and say why.` : ''}
Acceptance statements to prove on the deployed site:\n${deployed.map((a) => `- ${a}`).join('\n') || `- none tagged [deployed]${CONFIG.approve && CONFIG.approve.smoke ? ': run the smoke command' : ''}`}
Screens the run changed: ${uiTasks.map((t) => (t.routes || []).join(', ') || t.title).join('; ') || 'none'}${extra || ''}`
    approval = await run('approver', approvePrompt(reasons.length ? 'hand-back' : 'merge'), {
      label: 'approve',
      phase: 'Approve',
      schema: APPROVE,
    })
    if (approval && approval.outcome === 'failed-after-merge' && approval.failures.length) {
      // One fix round after the merge, then merge again and retest; a second
      // failure reverts the merge so the base branch is never left broken.
      await runFixers('deployed', approval.failures)
      await commitFixes('deployed-fix')
      const ci = await runCi('deployed-fix')
      approval =
        (await run(
          'approver',
          approvePrompt(
            'retest',
            `\nThe first merge failed and a fixer has pushed a fix. CI on the new pull request: ${ci.state}. If CI fails or the same checks fail again, revert your own merges (node scripts/loop/ship.mjs revert) and hand back with outcome "reverted".\nWhat failed the first time:\n${approval.failures.map((f) => `- ${f.where}: ${f.problem} (${f.evidence})`).join('\n')}`,
          ),
          { label: 'approve:retest', phase: 'Approve', schema: APPROVE },
        )) || approval
    } else if (approval && approval.outcome === 'failed-after-merge') {
      approval =
        (await run(
          'approver',
          approvePrompt(
            'revert',
            '\nThe merge failed with nothing a fixer can act on. Revert your merge and hand back with outcome "reverted".',
          ),
          { label: 'approve:revert', phase: 'Approve', schema: APPROVE },
        )) || approval
    }
    result.approval = approval
    if (approval)
      log(`Approve: ${approval.outcome}. ${approval.concerns.length ? `Concerns for ${OWNER}: ${approval.concerns.join(' | ')}` : ''}`)
  }
} finally {
  // --- Teardown: always, however the run ended ---------------------------------------
  phase('Teardown')
  result.teardown = await control(`node scripts/loop/run.mjs finish --slug ${SLUG} --run ${RUN_ID}`, 'finish')
  result.stopped = stopped
}

// --- Retro ------------------------------------------------------------------------------
if (has('retro')) {
  phase('Retro')
  result.retro = await run(
    'retro',
    `Look back at this run. Its cost report is ${RUN_DIR}/cost.md and its report ${RUN_DIR}/report.md. Checks: ${result.checks ? (result.checks.ok ? 'pass' : 'fail') : 'not run'}; CI: ${result.ci ? result.ci.state : 'not run'}; gates: ${result.gates.map((g) => `${g.gate} ${g.pass ? 'pass' : 'fail'}`).join(', ') || 'none'}; fix rounds ${result.fixRounds}; tasks not done: ${(result.notDone || []).join(', ') || 'none'}; open follow-ups ${result.followUpsOpen.length}; decisions sent to the lead: ${result.decisions.join('; ') || 'none'}; approval: ${approval ? `${approval.outcome}${approval.concerns.length ? ` (${approval.concerns.join('; ')})` : ''}` : 'did not run'}. Append dated lessons to docs/build-loop/lessons.md (one line each, starting "- ", only what a future run should do differently). Return each proposed change as a check the lead can add: a dry-run case, a guard rule, a script check or a settings value in .claude/workflows/loop.config.json, never only a sentence of advice.`,
    { label: 'retro', phase: 'Retro', schema: RETRO },
  )
}

return result
