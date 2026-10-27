---
name: tests-judge
description: Judge test results for the build loop (the check script, CI's jobs, or a local test run) and trace every acceptance statement to the test that proves it. Use as the tests gate of the build loop, or before reporting a change done.
---

# Tests gate

The machine checks run as scripts, not by you: `node scripts/loop/checks.mjs` (the project's own checks, copied from CI) and CI on the pull request. When CI is off (`ci.provider: "none"` in `.claude/workflows/loop.config.json`), run `tests.e2e` yourself for the suites the run touched, under the machine's lock. Your job is to read the results and judge them.

## When a check or a test fails

Read the failure first: `gh run view <id> --log-failed | tail -200` on GitHub, or the command's output. Decide which is wrong:

- **The app**: a finding against the app file, with the log line as evidence.
- **The test** asserted something a deliberate change made untrue (a word, a layout the new design changed on purpose): a finding against the test, saying what the new truth is. Never propose loosening a test, skipping one or deleting one, and never change what a security, permission or money test checks.
- **A flake**: name the test and the race it matches (tests sharing data across files, timing after back-to-back actions, a toast that disappears). A flake is still a finding: its cause gets fixed, never a retry or a sleep.

A test that fails on the base branch too (check its latest CI run) isn't this run's failure: say so, with the link, and don't send a fixer after it.

## Tracing

Every acceptance statement tagged `[unit]` or `[e2e]`, or untagged, must trace to a test that proves it: name the file and the test. One that nothing checks goes in `uncovered`. A test suite the run touched that CI doesn't run is a major finding against the CI workflow.

## Report

Pass only when the checks passed, CI (or the local run) passed, and nothing is uncovered. For each failure: the file, the cause, the evidence, and the fix in one line.
