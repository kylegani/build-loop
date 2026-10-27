# Build loop

A build loop for [Claude Code](https://claude.com/claude-code). You describe a change in plain words. A team of agents writes a spec, builds the change in parallel, runs your checks and CI, reviews it, and fixes what the review found. Then the loop either merges the change or gives it back to you with a list of concerns and the evidence for each.

It doesn't assume a stack. The first time, it reads your repo and writes down what it found: your frameworks and the versions you have installed, the checks your CI runs, which commands are slow or dangerous, and which files you want to review yourself whenever they change. Every agent works from that file.

## Why it exists

One agent building a small change works well. When I had several agents build something that touched many files, the same problems kept coming back, and adding to the prompt didn't fix them. This loop is the set of rules I ended up with. Where I could, I enforced a rule in the workflow script or in a hook instead of the prompt. A hook runs outside the agent, so it refuses the command whatever the agent has been told since.

- Several builders working at once edited the same files and undid each other's work. Each task in the spec now owns a set of files, and two tasks only build at the same time when they share none. If a builder needs a change in a file it doesn't own, it asks for it in its result.
- Builders wrote code for the version of a framework they remembered, not the one installed. Now anything the repo's own docs don't answer becomes a research question first, answered from the official docs for the version in your lockfile.
- Screens built from a model's defaults looked like every other generated screen, with rows of identical cards and coloured badges. A new screen is now designed against the best existing screen in your project and a few real products. It's built on its own and screenshotted at desktop and phone widths, in light and dark. Other work builds on it only after it has been reviewed.
- A task counted as done when the agent said so, with nothing checking it. Your own checks now run as scripts before any reviewer starts. The spec lists acceptance statements, which are checkable sentences that say what done means. A tests reviewer has to name the test behind each one, and a statement with no test fails the review.
- The quickest way for a fixer to make a check pass is to loosen the test or raise a threshold. Fixers aren't allowed to. A change to a test's expectation, a baseline or a budget is reported as a decision for you instead.
- Seven builders running at once used up a usage allowance before any of them reported back. The loop now runs two agents at a time, and each role gets the cheapest model that does its job well. Each builder starts from a short reading file instead of exploring the repo, and stops after a set number of tool calls. The whole run pauses when it reaches a token budget, and running it again with the same name picks up where it stopped.
- Test suites, dev servers and builds ran side by side until the machine slowed and commands timed out. An agent that waited with a sleep loop left that loop running after the agent had finished. Now only some roles may start servers, test runs and builds, one at a time, under a lock. The guard refuses sleep loops. When a run ends, it stops anything its own agents left running. It never touches a server you started yourself.
- An agent with a shell can push to main or throw work away. The guard hook refuses pushes to protected branches, force pushes, `git stash`, `git reset --hard`, and any deploy or production command you list, for every agent in the loop. Only the approver can push or merge. Your own Claude Code session is never blocked.
- A risky change could be merged with nobody looking at it. Any change to files you've marked as risky, such as auth, permissions or billing, comes back to you. So does a migration that changes existing rows, a decision nobody has made, or a check that still fails. The approver can add reasons to give a change back, but it can't remove one.
- The same mistakes came back in the next run. Each run now ends with a retro that writes one-line lessons, and the next run reads them. The retro proposes each improvement as something the loop can check: a test of the loop itself, a guard rule or a setting.

## How a run goes

```
Preflight -> Spec -> Research -> Build waves -> Checks -> CI -> Gates -> one Fix round
   -> Document -> Approve (merge and check, or hand back) -> Teardown -> Retro
```

| Stage | What happens |
| --- | --- |
| Spec | An agent turns your goal into decisions and a set of tasks, with the files each task owns and what it depends on. It lists anything only you can decide, such as pricing, legal wording, deleting data or breaking an API, and plans the tasks around it. |
| Research | A researcher answers each open question in a short write-up with its sources: design questions from design-reference tools or real products, framework questions from the official docs, common practice from a web search, and a third-party service from that service's own API docs. Builders read only the decision. |
| Build | Two agents at a time build the tasks in waves. After each wave an integrator runs your checks and commits. |
| Checks and CI | Your own checks run first. With GitHub, the loop then pushes the branch, opens a pull request and reads CI's results. |
| Gates | Reviewers look at the tests, the screens, API compatibility, the wording, security and the docs. Two more check the whole feature against a readiness standard kept in your repo. They report problems and fix nothing. |
| Fix | Fixers get one round, grouped by file. The loop then rechecks only what failed, and anything still failing comes back to you. |
| Approve | By default the approver never merges. It reads the diff and writes its verdict on the pull request. You can let it merge into an integration branch such as `staging` once everything has passed; it then checks the deploy and reverts its own merge if something breaks. |
| Audit | Run with `stages: ["audit"]`, the loop reviews the entire repo against the readiness standard and turns what it finds into tasks for the next run. |

The full detail, including which model each role uses and who may run what, is in `.claude/skills/build-loop/reference.md`.

## What you need

- Claude Code with the Workflow tool and custom agent types (`.claude/agents`).
- Node 18 or later, and git.
- Optional: the GitHub CLI (`gh`), signed in, for pull requests, CI and merging. Without it the loop runs your checks and tests on your machine and writes its verdict to a file.
- Optional: Playwright in the repo, for screenshots of web screens. Other projects can name their own screenshot command, or skip the screen review.
- Optional: a design-reference tool, such as an MCP server that searches real product screens. Without one, design research uses web search and your own screens.

## Install

```
git clone https://github.com/kylegani/build-loop
node build-loop/install.mjs /path/to/your/repo
```

The installer copies the skills, agent types, workflow and scripts into your repo, adds the guard hook to `.claude/settings.json`, and adds `.loop/` and `.claude/worktrees/` to `.gitignore`. Files you already have are left alone unless you pass `--force`. Your project's settings come later, from setup.

Then open a new Claude Code session in your repo, so it picks up the new agent types, and say:

> set up the build loop

Setup starts with `scripts/loop/detect.mjs`, then reads your docs and CI. From those it records each dependency's installed version and official docs, copies the checks your CI runs, and marks which commands are slow and which are dangerous. For a project with screens, it also looks for your design docs and any design-reference tools on your machine. A readiness standard cut to your project goes into `docs/build-loop/readiness.md`.

Setup also asks you what only you can decide, such as your base branch, whether the loop may merge, and which files should always come to you. Your answers and everything it found go into `.claude/workflows/loop.config.json`, with a note beside each value saying where it came from.

## Run a change

> run the loop: let customers export their invoices as CSV

To do it step by step, make the run's worktree with `node scripts/loop/run.mjs worktree --slug invoice-export` and enter it. Then start the workflow with `scriptPath: ".claude/workflows/build-loop.js"` and `args: { goal, slug, title }`. The `build-loop` skill explains the other options, such as running only the spec first so you can read it before anything is built.

A run saves its spec, state, report and cost to `docs/build-loop/runs/<slug>/` and its research to `docs/build-loop/research/<slug>/`, on the run's branch.

## Settings

The defaults are in `scripts/loop/lib/loop.defaults.json`, each with the reason for its value. Anything you set in your project's `.claude/workflows/loop.config.json` replaces the default. These are the ones you're most likely to change:

| Setting | What it does |
| --- | --- |
| `baseBranch` | The branch runs start from and open pull requests into |
| `approve.mode` | `"hand-back"` (never merges) or `"merge"` |
| `riskPaths` | Files that always come to you, grouped by area |
| `checks`, `builderChecks` | Your checks, and the quick ones a builder runs on its own files |
| `heavyCommands`, `forbiddenCommands`, `protectedBranches` | What the guard limits or refuses |
| `models`, `strongWhen` | The model each role uses, and when a role moves to a stronger one |
| `maxParallel`, `budgetTokens` | How many agents run at once, and the token budget per run |
| `screens`, `design` | How screenshots are taken, and where design references come from |

## Cost

A run reads tens of millions of tokens, because a feature run uses dozens of agents and each one rereads its whole context on every turn. By default a run stops building once it has read 80M tokens. It finishes the wave it's in first, and running the same slug again carries on from there. Each run writes a `cost.md` showing every agent's model, turns and tokens, and the next run uses the last three to estimate its cost before it starts.

## The machine lock

The check script and the screenshot script take a lock in `.loop/` that covers the whole machine, so they never run at the same time as each other or as another run. You can make your own e2e runs respect it too by taking the lock in your test runner's config. A run that finds the lock held exits and says what is holding it. For Playwright:

```ts
import { takeHeavyLock } from './scripts/loop/lib/heavy-lock.mjs'

// The runner takes the lock, not its workers, which load this file too.
if (!process.env.CI && process.env.TEST_WORKER_INDEX === undefined) {
  takeHeavyLock('the e2e suite')
}
```

To wait for the lock instead of exiting, pass a wait time: `takeHeavyLock('the e2e suite', { waitMs: 8 * 60 * 1000 })`.

## Checking the loop itself

```
node scripts/loop/self-check.mjs
```

The self-check confirms every loop script parses, then runs the dry run (the real workflow with stub agents in place of Claude: 65 checks, no tokens spent) and the guard's tests. Run it before and after you change the loop.

## License

MIT. See `LICENSE`.
