#!/usr/bin/env node
// PreToolUse hook for Bash (wired in .claude/settings.json and in each
// .claude/agents/loop-*.md). It enforces the build loop's rules for agents,
// so a run's instructions can't talk an agent out of them:
//
//   - once a run is stopped (.loop/stop exists), every subagent's next
//     command is refused, so agents wind down instead of retrying;
//   - no subagent polls with a sleep loop;
//   - no loop agent touches a protected branch or runs anything on the
//     forbidden list;
//   - only gates, integrators, fixers, the approver and the runner (which
//     runs the loop's own check scripts) start heavy processes (servers,
//     browsers, builds, test runs);
//   - only the approver pushes, merges, reverts or comments;
//   - only integrators, fixers and the approver commit.
//
// The main session (no agent_id) is never blocked: the person and the lead
// stay in control. Exit 2 with a message is how a hook refuses a tool call.
//
//   node scripts/loop/guard.mjs [role]    role from an agent file, else from agent_type
import { appendFileSync, existsSync, mkdirSync } from 'node:fs'
import { join } from 'node:path'
import {
  LOOP_DIR,
  STOP_FILE,
  invokesForbidden,
  invokesHeavy,
  invokesOutward,
  loopConfig,
  segments,
  bare,
} from './lib/loop-config.mjs'

const HEAVY_ROLES = new Set([
  'loop-gate',
  'loop-integrator',
  'loop-fixer',
  'loop-approver',
  'loop-runner',
])
const COMMIT_ROLES = new Set(['loop-integrator', 'loop-fixer', 'loop-approver'])

let input = ''
for await (const chunk of process.stdin) input += chunk
const call = JSON.parse(input || '{}')
const command = call.tool_input?.command ?? ''
const role = process.argv[2] ?? call.agent_type ?? null
const subagent = Boolean(call.agent_id || call.agent_type)
const loopRole = Boolean(role && role.startsWith('loop-'))

if (existsSync(join(LOOP_DIR, 'guard-debug'))) {
  mkdirSync(LOOP_DIR, { recursive: true })
  appendFileSync(
    join(LOOP_DIR, 'guard.log'),
    `${JSON.stringify({ at: new Date().toISOString(), agent_id: call.agent_id, agent_type: call.agent_type, role, command: command.slice(0, 120) })}\n`,
  )
}

function refuse(message) {
  console.error(message)
  process.exit(2)
}

if (!subagent && !loopRole) process.exit(0)

if (existsSync(STOP_FILE))
  refuse(
    "This build loop run was stopped (.loop/stop). Don't start anything new and don't retry: report what you have done and what is left, and finish.",
  )

// A polling loop outlives the agent's command timeout and keeps running as an
// orphan.
if (/\b(until|while)\b[\s\S]*\bdo\b[\s\S]*\bsleep\b/.test(command))
  refuse(
    "Don't poll with a sleep loop: it keeps running after your command times out. Run the work in the foreground instead, split so each command ends within 10 minutes.",
  )

if (!loopRole) process.exit(0)
const config = loopConfig()
const name = role.slice(5)

if (invokesForbidden(command, config))
  refuse(
    'No agent in the build loop runs this: it touches a protected branch, production, a shared database or a release, or it throws work away. Say in your result what you needed it for, and the lead will decide.',
  )

if (!HEAVY_ROLES.has(role) && invokesHeavy(command, config))
  refuse(
    `A ${name} doesn't start servers, browsers, test runs or builds; the gates do, one at a time. Don't work around this: carry on without it, and say in your result what you could not check.`,
  )

// A role's own outward commands (roleCommands) pass; every other outward
// segment of the same command line is still refused.
const own = (config.roleCommands[role] ?? []).map(bare)
const outward = segments(command).filter(
  (segment) =>
    invokesOutward(segment, config) &&
    !own.some((p) => segment === p || segment.startsWith(`${p} `)),
)
if (role !== 'loop-approver' && outward.length)
  refuse(
    `Only the approver pushes, merges, reverts or comments on the pull request. A ${name} leaves that to it: say in your result what you needed.`,
  )

if (
  !COMMIT_ROLES.has(role) &&
  segments(command).some((segment) => /^git\s+commit\b/.test(segment))
)
  refuse(`A ${name} doesn't commit: the integrator commits each wave once the checks pass.`)

process.exit(0)
