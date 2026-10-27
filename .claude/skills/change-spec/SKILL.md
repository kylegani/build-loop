---
name: change-spec
description: Turn a goal into a buildable spec and a task graph (what to build, which files each task owns, what it depends on, what it needs researched, how it is checked). Use at the start of any feature, redesign or cleanup that touches more than a couple of files, and as the first stage of the build loop.
---

# Spec

A spec is what lets several builders work at once without stepping on each other, and lets a gate say "done" without guessing. Write it before any code.

## Read first

The code the goal touches, the project's own rules (the `projectDocs` in `.claude/workflows/loop.config.json`), the stack summary in the same file, and the readiness standard it names. If the goal changes what a person sees, the project's design docs (`design.docs`) and the screen-design skill's "The order".

## What a spec holds

1. **Goal** in one sentence, in the user's words where they gave them.
2. **Decisions**: every judgement call, with the reason. Make the call; leave a question open only when it is the owner's alone (money, legal wording, deleting data, a breaking API change, anything sent to customers). Those go under "For the owner" and the tasks work around them.
3. **Tasks**: each with
   - `id` (short, kebab-case) and `title`;
   - `files`: the files and folders it owns. Two tasks that can run at the same time never own the same file. Files many tasks touch (the schema, the route table, the migrations folder, shared test setup, CI workflows, the project's rule docs) belong to one task only;
   - `dependsOn`: the ids that must finish first, and why;
   - `areas`: from the keys of `reading` in the settings. They pick the doc sections the builder reads and, with the files, which model builds it;
   - `sections`: extra doc sections as `path#Heading` when the areas don't cover what the task needs;
   - `research`: one `{ kind, question }` for each thing the repo's own docs don't settle. `design` for a screen with no close match among the project's existing screens; `convention` for a framework feature the repo doesn't use yet (answered from the official docs for the installed version); `practice` for how others solve it; `vendor` for how a third-party service behaves. Ask before building on a guess;
   - `designRisk`: true for a new screen or a redesign. It is built alone and reviewed on screenshots before anything builds on it;
   - `routes`: the screens that show it, as `/path as role`, with roles from `screens.roles`;
   - `projects`: the test suites whose tests it adds or changes. A new test goes in a suite CI runs, or the task adds its suite to CI;
   - `readiness`: how it holds to the readiness standard: who sees what (tenancy, roles), paging and bounded queries, audit records, concurrency and repeat submits, limits. For a migration, what happens to every existing row. The loop refuses a thin answer;
   - `acceptance`: checkable statements, each tagged with what proves it: `[unit]`, `[e2e]`, `[ui]` (the UI gate's screenshots), `[script]` (the check script), or `[deployed]` (the approver, after a merge);
   - `ui`: true when it changes what a person sees.
4. **Verification**: anything specific a gate should look at.
5. **Conventions to record**: the patterns this work sets and the doc each goes in.

Keep tasks small enough that one builder finishes one in a sitting, and large enough that a gate can judge it on its own. Tests belong to the task that builds the code, never to a later task.

Write the spec to the path the loop gives you, in plain words.
