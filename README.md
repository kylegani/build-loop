# Build loop

A build loop for [Claude Code](https://claude.com/claude-code). You give it a goal in plain words. It writes a spec, researches what it doesn't know, builds the change in parallel waves, checks it with your own scripts and CI, reviews it through a set of gates, fixes what failed once, and then either merges it or hands it back to you with its concerns and the evidence for each.

It works with any stack. On first use it reads your repo (manifests, lockfiles, CI, docs) and writes down your frameworks and their installed versions, the checks your CI runs, which commands are heavy or dangerous, and which paths must always come to a person. Every agent then works from that.

## Why it exists

Asking one agent to build a small change works well. Asking agents to build something that touches many files goes wrong in the same ways every time, and a longer prompt doesn't stop it. This loop is the set of rules I ended up with, and each rule is enforced by a script or a hook, because an agent can be talked out of a prompt but not out of a hook that refuses its command.

These are the problems, and what the loop does about each:

- **Agents editing at once overwrite each other.** Every task in the spec owns its files, and only tasks with no file in common build side by side. A change a builder needs in someone else's file comes back as a follow-up, not an edit.
- **Agents build on a guess.** They write code for the version of a framework they remember, not the one installed. Anything the repo's own docs don't settle becomes a research question, answered from the official docs for the installed version, before anyone builds on it.
- **Screens come out generic.** A model left to its defaults produces the same cards, gradients and colour-coded badges as every other generated screen. A new screen is designed against the project's own best screen and real references, built alone, screenshotted at desktop and phone widths in every theme, and reviewed before anything builds on it.
- **"Done" means the agent said so.** Your own checks run as scripts before any reviewer reads a line. A tests gate traces every acceptance statement in the spec to the test that proves it, and anything unproven fails.
- **Fixers move the bar.** The quickest way to make a check pass is to loosen the test or raise a threshold. Fixers may not: a change to a test's expectation, a baseline or a budget goes to the lead as a decision.
- **Parallel agents spend fast.** Seven builders at once can use up a usage allowance before any of them reports. The loop runs two agents at a time, gives each role the cheapest model its work allows, prepares a short reading file for each builder instead of letting it explore, stops each agent at a soft cap on tool calls, and pauses the run at a token budget. A run with the same name resumes where it stopped.
- **Agents fight over the machine.** Two test suites, a dev server and a build at once slow everything down until commands time out, and an agent that polls with a sleep loop leaves it running after the agent is gone. Only some roles may start heavy processes, one at a time under a lock; sleep loops are refused; teardown kills whatever the run's own agents left behind, and nothing else.
- **An agent with a shell can do damage.** The guard hook refuses pushes to protected branches, force pushes, `git stash`, `git reset --hard`, and any deploy or production command you list, to every agent in the loop. Only the approver may push or merge. Your own session is never blocked.
- **Risky changes slip through.** Anything touching paths you mark as risky (auth, permissions, billing, data deletion), a migration that changes existing rows, an open decision, or a check that still fails, always comes back to you. The approver may add reasons to hand back but never remove one.
- **Lessons don't stick.** Every run ends with a retro that writes one-line lessons, which the next run reads, and proposes each improvement as a check (a test of the loop, a guard rule, a setting), not as advice.

## How a run goes

```
Preflight -> Spec -> Research -> Build waves -> Checks -> CI -> Gates -> one Fix round
   -> Document -> Approve (merge and check, or hand back) -> Teardown -> Retro
```

- **Spec**: the goal becomes decisions and a task graph. Questions only you can answer (money, legal wording, deleting data, breaking an API) are listed for you, and the tasks work around them.
- **Research**: one write-up per question, each from the kind of source its kind allows: design-reference tools or real products for design, official docs for framework conventions, web search with sources for industry practice, the vendor's own API docs for vendor behaviour.
- **Build**: waves of tasks, two agents at a time, with a check and a commit after each wave.
- **Checks and CI**: your own checks, then CI on a pull request if you use GitHub.
- **Gates**: tests, UI, API compatibility, copy, security, docs, and two readiness reviewers who hold the whole feature to a written standard (who sees what, data at scale, integrity, operations, complete screens). Gates report; they never fix.
- **Fix**: one round, grouped by file, then a recheck of only what failed. What still fails goes to you.
- **Approve**: by default the approver never merges; it writes its verdict on the pull request. You can let it merge into an integration branch (such as `staging`) when everything passed, check the deploy, and revert its own merge if the result breaks.
- **Audit mode** (`stages: ["audit"]`) holds the whole repo, not a diff, to the readiness standard and turns what it finds into a task graph for the next run.

`.claude/skills/build-loop/reference.md` has the detail: every stage, the model each role uses, who may run what, and the files a run writes.

## What you need

- Claude Code with the Workflow tool and custom agent types (`.claude/agents`).
- Node 18 or later and git.
- Optional: the GitHub CLI (`gh`), signed in, for pull requests, CI and merging. Without it the loop runs your checks and tests locally and writes its verdict to a file.
- Optional: Playwright in the repo, for screenshots of web screens. Any other project can name its own screenshot command, or skip the UI gate.
- Optional: a design-reference tool (for example a screen search MCP server). Without one, design research uses web search and your own screens.

## Install

```
git clone <this repo> build-loop
node build-loop/install.mjs /path/to/your/repo
```

The installer copies the skills, agent types, workflow and scripts into your repo, adds the guard hook to `.claude/settings.json`, and adds `.loop/` and `.claude/worktrees/` to `.gitignore`. It never overwrites a file that exists unless you pass `--force`, and it writes no settings for your project.

Then open Claude Code in your repo (a new session, so it sees the new agent types) and say:

> set up the build loop

Setup runs `scripts/loop/detect.mjs`, reads your docs and CI, records your stack with each dependency's installed version and official docs, copies your CI checks, marks heavy and dangerous commands, finds your design docs and any design-reference tools you have, writes a readiness standard cut to your project, and asks you the few things only you can decide (your base branch, whether it may merge, which paths always come to you). It writes `.claude/workflows/loop.config.json`, with the reason for each value beside it.

## Run a change

> run the loop: let customers export their invoices as CSV

Or, step by step: make the run's worktree with `node scripts/loop/run.mjs worktree --slug invoice-export`, enter it, and start the workflow with `scriptPath: ".claude/workflows/build-loop.js"` and `args: { goal, slug, title }`. The `build-loop` skill covers the options: running the spec and research first and reading them before the build, passing your own task graph, choosing gates, and stopping a run.

A run writes its spec, state, report and cost to `docs/build-loop/runs/<slug>/`, and its research to `docs/build-loop/research/<slug>/`, on the run's branch.

## Settings

Defaults are in `scripts/loop/lib/loop.defaults.json`, each with its reason. Your project's `.claude/workflows/loop.config.json` overrides any of them. The ones you are most likely to change:

| Setting | What it does |
| --- | --- |
| `baseBranch` | The branch runs start from and open pull requests into |
| `approve.mode` | `"hand-back"` (never merges) or `"merge"` |
| `riskPaths` | Paths that always come to you, by area |
| `checks`, `builderChecks` | Your checks, and the fast per-file ones builders run |
| `heavyCommands`, `forbiddenCommands`, `protectedBranches` | What the guard limits or refuses |
| `models`, `strongWhen` | The model each role uses, and when a role moves up |
| `maxParallel`, `budgetTokens` | Agents at once, and the token budget per run |
| `screens`, `design` | How screenshots are taken, and where design references come from |

## Cost

A run reads a lot of context. Each agent rereads its context on every turn, and a feature run uses tens of agents. The default budget is 80M tokens of context read per run; the build pauses after a wave when it is reached, and the same slug resumes. Every run writes `cost.md` with each agent's model, turns and tokens, and the preflight estimates the next run from the last three.

## One heavy process at a time

The check script and screenshots take a machine-wide lock in `.loop/`, so they never run beside each other or beside another run. To make your own e2e runs wait their turn too, take the lock in your test runner's config. For Playwright:

```ts
import { takeHeavyLock } from './scripts/loop/lib/heavy-lock.mjs'

// The runner takes the lock, not its workers, which load this file too.
if (!process.env.CI && process.env.TEST_WORKER_INDEX === undefined) {
  takeHeavyLock('the e2e suite')
}
```

## Checking the loop itself

```
node scripts/loop/self-check.mjs
```

Every loop script must parse, the dry run must pass (the real workflow driven by stub agents, about 65 checks, no tokens), and the guard's tests must pass. Run it before and after any change to the loop.

## License

MIT. See `LICENSE`.
