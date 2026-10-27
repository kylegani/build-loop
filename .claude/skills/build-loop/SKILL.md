---
name: build-loop
description: Run a change through the build loop (spec, research, design and build in waves, script checks, CI, review gates, one fix round, then an approver that merges or hands back to the owner with concerns). Use for any feature, redesign or cleanup that touches more than a couple of files, for the periodic readiness audit, when asked to "run the loop", or to set the loop up in a new repo.
---

# Build loop

The build loop takes a goal in plain words to work that is built, checked and either merged or handed back with its concerns. It is a Claude Code workflow (`.claude/workflows/build-loop.js`), ten agent types (`.claude/agents/loop-*.md`), the skills they follow, and the scripts in `scripts/loop/`. `reference.md` beside this file describes the stages, the models, who may run what, and the controls.

The loop knows nothing about a project until setup has run. Setup reads the repo and writes `.claude/workflows/loop.config.json`, which tells every agent what the stack is, which checks to run, where the docs are, and what must go to a person. If that file doesn't exist, do setup first.

## Setup (once per repo)

1. Run `node scripts/loop/detect.mjs`. It prints facts about the repo: manifests and lockfiles, installed versions, package scripts, CI workflows and the commands they run, docs, end-to-end test setup, migration folders, env files, the git remote and branches. It decides nothing.
2. Read what it found, then read the repo's own rules (CLAUDE.md, AGENTS.md, CONTRIBUTING.md, an architecture doc) and the CI workflow that runs on pull requests.
3. Work out the stack. For every dependency that shapes how code is written (the framework, router, ORM or database client, UI kit, styling, validation, test runners, the job queue, the deploy tool), record its name, the installed version (from the lockfile or installed package, not the range), and its official docs site. Find the docs site by searching when you don't know it, and prefer the maintainers' own site over any mirror. This is what keeps builders on the conventions of the versions the repo actually runs, not the ones in a model's memory. Write one plain sentence summing up the stack.
4. Find the checks. Copy what CI runs on a pull request, so the loop and CI agree on what a failure is: typecheck, lint, format check, unit tests (related to changed files where the runner supports it), schema or API document checks, migration checks. Each becomes `{ name, command, when?, files? }` (see `checks` in `scripts/loop/lib/loop.defaults.json`). Add `builderChecks`: the fast per-file checks a builder runs on its own files (lint with fix, the nearest unit tests), never a whole build.
5. Find what is heavy: the dev server, the build, the full typecheck, the e2e runner, anything with docker. Add each to `heavyCommands`, so only the roles that may run them do, one at a time.
6. Find what is dangerous: deploy and release commands, production or shared database commands, infrastructure apply commands, anything that publishes. Add them to `forbiddenCommands` or `forbiddenPatterns`. Put the branches nobody may push to in `protectedBranches`.
7. Find the screens, if the project has any. For a web app with Playwright installed, set `screens` with the local URL, the command that starts a server for tests, and one role per saved session file the e2e setup writes (plus `anonymous: null`). For anything else (a mobile app, a desktop app, a web app without Playwright), set `screens.command` to the project's own way of taking screenshots, or leave `screens` null and the UI gate is skipped. Never install a dependency to make this work without asking.
8. Find the design sources. List the project's design docs (a design system doc, tokens, the UI kit's docs) in `design.docs`, and where its best screens live in `design.exemplars`. Then check which design-reference tools this machine has: run ToolSearch for screen, flow and pattern search tools (any MCP server that searches real product screens or design files) and list the exact tool names in `design.referenceTools`. Add those names to the `tools:` line of `.claude/agents/loop-researcher.md` too, or the researcher can't call them. If there are none, leave the list empty: design research then uses web search for real, shipped products and the project's own screens. If a design critique skill is installed (see the skill list), name it in `design.critiqueSkill`.
9. Split the docs into areas. Choose the areas a task can name (for example `ui`, `data`, `api`, `auth`, `jobs`, `e2e`) and, for each, the few doc sections a builder of that area needs, as `path#Heading`. Keep each area short: a builder rereads its prepared reading on every turn.
10. Write the readiness standard. Copy `readiness.template.md` from this folder to `docs/build-loop/readiness.md` and cut it to this project: drop what doesn't apply (no screens, no tenants, no migrations), and point each rule at where the project already writes it down.
11. Ask the owner what only they can decide, with AskUserQuestion, recommending a default for each:
    - their name, for hand-backs (`owner`);
    - the base branch runs start from and open pull requests into (the default branch, or an integration branch such as `staging` or `develop`);
    - whether the approver may merge (`approve.mode: "merge"`) or always hands back (`"hand-back"`, the safe default). Merge mode needs GitHub, and should only be used with a base branch that deploys somewhere safe to test;
    - which paths always go to them (`riskPaths`), suggested from what you saw: auth, permissions, billing, payments, data deletion;
    - a commit trailer, if they want one.
12. Write `.claude/workflows/loop.config.json` with only the keys that differ from the defaults, each with a `<key>Why` beside it saying where the value came from. Make sure `.loop/` is in `.gitignore`. Then run `node scripts/loop/self-check.mjs`.
13. Tell the owner what you set, what you couldn't find, and what you assumed.

Run setup again when the stack changes in a way a builder should know (a framework's major version, a new test runner, a new deploy target).

## Running a change

1. Run `node scripts/loop/self-check.mjs` if anything under `scripts/loop/` or `.claude/workflows/` changed since it last passed.
2. Pick a slug: short, kebab-case, the name of the change (`invoice-reminders`). It names the branch, the worktree and the run folder, and a later run with the same slug resumes.
3. Make the run's worktree: `node scripts/loop/run.mjs worktree --slug <slug>`. It branches from the base branch under `.claude/worktrees/`, copies the env files, and installs. Enter it with the EnterWorktree tool and the `path` it printed. The loop refuses to start anywhere else, so it never touches the owner's checkout.
4. Decide how much to hand over. A contained change: pass only `goal` (and a `title` for the pull request). A large one: run it in parts and read each result before the next (`stages: ["spec", "research"]`, then the rest). Debt already in the code: `stages: ["audit"]`, then build what it returns.
5. Call the Workflow tool with `scriptPath: ".claude/workflows/build-loop.js"` (not by name: a saved workflow loads once per session) and `args` (`goal`, `slug`, `title`, and optionally `tasks`, `context`, `stages`, `gates`, `decisions`).
6. Don't start another run, an e2e run or screenshots while it runs: the run lock and the heavy lock refuse them anyway.
7. When it returns, read `approval` first: merged and checked, handed back, or reverted. Then `checks`, `ci`, `gates`, `decisions`, `followUpsOpen`, `retro.proposals`, and the run's `report.md` and `cost.md` under `docs/build-loop/runs/<slug>/`. Tell the owner the outcome and every concern, with the pull request link. Decide each retro proposal and record what you change.
8. A run that ends handed back leaves its pull request open for the owner. A run that ended merged leaves the worktree; remove it with ExitWorktree once nothing is left to do on the branch.
9. To stop a run: `node scripts/loop/run.mjs stop`, stop the workflow, wait until its agents are idle, then `node scripts/loop/run.mjs finish --slug <slug> --run <runId>`.

## Changing the loop

Run `node scripts/loop/self-check.mjs` before and after. Settings change in `.claude/workflows/loop.config.json`, with the reason beside each. A retro proposal becomes a check (a dry-run case, a guard rule, a script check or a setting), not a note. Never edit the loop's files while a run is using them.
