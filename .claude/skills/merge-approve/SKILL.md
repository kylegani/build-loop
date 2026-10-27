---
name: merge-approve
description: Decide whether a build loop run merges, check it after the merge, and hand back to the owner with concerns when it doesn't hold. Use only as the build loop's approver.
---

# Approve

You merge only in merge mode. Everything that touches who can see what, money, existing data or a breaking API change goes to the owner, and so does anything a check, a gate or CI still fails. You may add a reason to hand back; you never remove one. You never touch a protected branch or production.

The settings are in `.claude/workflows/loop.config.json` (`approve`, `baseBranch`, `owner`).

## Modes

**hand-back**: don't merge. Read the diff once yourself, so your verdict is your own. Then write the hand-back (below) and return `handed-back`. When the only reason is that this project never lets the loop merge, say plainly whether you would have merged and why.

**merge**:

1. Read `git diff origin/<base>...HEAD` once yourself. If you find a reason the checks missed (access, money, existing data, a breaking API change, something people would notice that nobody decided), hand back instead and say why.
2. `node scripts/loop/ship.mjs merge --slug <slug>`. Keep the merge sha.
3. If `approve.deployWorkflow` is set: `node scripts/loop/ship.mjs deploy --sha <sha>`, again while it says the run is still going. A failed deploy is a failure.
4. If `approve.versionCheck` is set: `node scripts/loop/ship.mjs version --sha <sha>`. The site must serve the merge commit.
5. If `approve.smoke` is set, run it. Then prove each acceptance statement tagged `[deployed]`, with a test or by looking, and shoot the screens the run changed if the settings allow it. Use only test accounts and test data, delete what you create, and never send real messages to real people.
6. Pass: return `merged` with what you tested. Fail in the run's own work: return `failed-after-merge` with each failure as a finding (file, problem, evidence). Fail for a reason no fixer can act on (the site is down, a deploy never started, someone else's change): return `failed-after-merge` with no failures.

**retest**: the loop pushed a fix. Merge the new pull request, then steps 3 to 6. Pass: `merged`. Fail again, or CI failed: `node scripts/loop/ship.mjs revert --slug <slug>` and return `reverted`.

**revert**: `node scripts/loop/ship.mjs revert --slug <slug>`, then the hand-back, and return `reverted`.

## The hand-back

Write it in plain words to a file under `.loop/` and post it with `node scripts/loop/ship.mjs comment --slug <slug> --body-file <file>`. With no pull request (CI off), save it to the run folder instead: `node scripts/loop/run.mjs save --slug <slug> --name handback.md`.

- **Outcome**: merged and checked, ready to merge, handed back, or reverted.
- **Concerns**: each one with its evidence (a file and line, a log line, a screenshot, a gate's finding) and what the owner would need to decide.
- **What I tested**, and **what I couldn't**, and why.
