# How the build loop works

## The stages

```
Preflight -> Spec -> Research -> Build waves -> Checks -> CI -> Gates -> one Fix round
   -> Document -> Approve (merge and check, or hand back) -> Teardown -> Retro
Audit (on its own): the whole repo against the readiness standard -> a task graph for the next run
```

| Stage | What happens | Agent type |
| --- | --- | --- |
| Preflight | Refuses to run outside the run's own worktree. Takes the run lock, reads the settings, earlier state and the newest 20 lessons, and estimates the cost from earlier runs. | `loop-runner` |
| Spec | The goal becomes decisions and a task graph. Each task owns its files, names its areas, asks a research question for anything new, answers the readiness standard, and tags its acceptance statements. | `loop-spec` |
| Research | One write-up per question, from one kind of source: design-reference tools or real products for design, official documentation for the installed version for framework conventions, web search with sources for industry practice, the vendor's own API docs for vendor behaviour. Builders read only the decision. | `loop-researcher` |
| Preview | A new screen or redesign is built alone, shot at every width and theme, reviewed, and fixed before anything builds on it. | `loop-builder`, `loop-gate`, `loop-fixer` |
| Build | Waves of tasks whose dependencies are done and whose files don't overlap, two at a time. Each builder starts from `scripts/loop/context.mjs`: the stack and versions, and only the doc sections its areas need. A builder designs its own screen with `screen-design`. | `loop-builder` |
| Integrate | After each wave: the check script, fixes where tasks meet, and one commit. | `loop-integrator` |
| Checks | `scripts/loop/checks.mjs` runs the project's own checks, copied from CI. A failure goes straight to a fixer with the error text. | `loop-runner` |
| CI | With GitHub: the branch is pushed, a pull request opened, and its checks read. Without it the stage is skipped and the tests gate runs the tests. | `loop-runner` |
| Gates | Only what needs judgement: tests (every acceptance statement traced), ui, api, copy, security, docs, and two readiness reviewers. Gates fix nothing. | `loop-gate`, `loop-reviewer` |
| Fix | One round: fixers grouped by file, then the checks, CI and a recheck of only what failed. What still fails goes to the lead. | `loop-fixer` |
| Document | Conventions recorded, the run report written and committed. | `loop-integrator` |
| Approve | Merges and checks the result, or hands back (below). | `loop-approver` |
| Teardown | Always runs. Kills heavy processes its own agents left, releases the locks, writes the cost report. | `loop-runner` |
| Retro | Lessons, and every proposed change to the loop as a check: a dry-run case, a guard rule, a script check or a setting. | `loop-retro` |

## When the approver merges

Only in `approve.mode: "merge"`, which needs GitHub, and only when the checks, CI and every gate passed, no decision is open, nothing is left unbuilt, and `scripts/loop/ship.mjs risk` finds nothing. The risk check reads the diff: a path in `riskPaths`, or a migration that changes existing data (`dataChangingSql`). Docs and tests never count. The approver reads the diff too and may add a reason to hand back, never remove one.

After a merge it waits for the deploy (`approve.deployWorkflow`), checks the site serves the merge commit (`approve.versionCheck`), runs the smoke command and proves the acceptance statements tagged `[deployed]`. A failure in the run's own work gets one fix round and a second merge; if that fails too, the approver reverts its own merges so the base branch is never left broken, and hands back.

In `"hand-back"` mode (the default) the approver never merges. It writes its verdict on the pull request: ready, or the concerns that stop it.

A hand-back says the outcome, each concern with its evidence, what was tested and what couldn't be.

## Models

Each role runs on the model its work needs (`models` in the settings):

| Model | Roles |
| --- | --- |
| Haiku | the runner, which only relays a script's output |
| Sonnet | integrators, the retro, builders of tasks with no screen, access, API or risky path, research from official or vendor docs, the tests, api, copy and docs gates |
| Opus | the spec, readiness and audit reviewers, the UI and security gates, design previews and design research, fixers, the approver, and any builder whose task has a screen, a design risk, auth, the API or a risky path |

A builder that returns nothing or stops part way is retried on the strong model. `cost.md` records each agent's model, so the retro can compare first-pass gate failures by model. `args.model` forces one model for every agent.

## Who may run what

Rules live in the agent types and the guard hook (`scripts/loop/guard.mjs`), which a run's prompt can't change. The main session is never blocked.

| Role | May run |
| --- | --- |
| builder, researcher, spec, reviewer, retro | reading, writing their own files, and the per-file builder checks |
| gate, integrator, fixer, runner | servers, e2e and screenshot runs, builds and the check script, one at a time under the machine's heavy lock |
| integrator, fixer, approver | `git commit` |
| approver | pushing, merging, reverting, pull request comments |
| nobody in the loop | protected branches, force pushes, `git stash`, `git reset --hard`, `git clean`, and every command in `forbiddenCommands` |

## Controls

- **Worktrees.** Every run works on its own branch in its own worktree under `.claude/worktrees/`. Locks live in `.loop/` beside the shared `.git`, so they hold across every worktree on the machine.
- **One run at a time.** The run lock has a heartbeat; a crashed run's lock counts as abandoned after `abandonedLockMinutes`.
- **One heavy process at a time.** The check script and screenshots take the heavy lock. A project can take it in its own e2e runner too (see the README).
- **A stop switch.** `node scripts/loop/run.mjs stop`; the guard then refuses every subagent's next command.
- **No polling.** The guard refuses sleep loops; the scripts wait in the foreground in pieces under 10 minutes.
- **Budget.** `budgetTokens` read per run. Over it, the build pauses after a wave and fix rounds stop; the same slug resumes.
- **Resume.** A commit after each wave and `docs/build-loop/runs/<slug>/state.json`.

## Files a run writes

```
docs/build-loop/
  readiness.md            the standard (written at setup)
  lessons.md              one line per lesson, newest last
  costs.json              every run's cost by role, for the next estimate
  research/<slug>/        one write-up per research question
  runs/<slug>/            spec.md, state.json, report.md, cost.md, handback.md
.loop/                    locks, the stop switch, screenshots, prepared reading (not committed)
```
