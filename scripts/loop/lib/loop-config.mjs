// Reads the build loop's settings and the paths its scripts share. The
// defaults sit beside this file (loop.defaults.json); a project's own
// .claude/workflows/loop.config.json, written by the build-loop skill's setup,
// is laid over them key by key.
//
// A run works in its own git worktree, so two kinds of path exist:
//   - ROOT is the checkout this file sits in (the run's worktree during a
//     run). Run records, research, lessons and costs are files in it,
//     committed with the run's branch.
//   - LOOP_DIR sits beside the repository's shared .git, so the run lock,
//     the stop switch and the heavy lock hold across every worktree on the
//     machine: one run and one heavy process at a time, whichever checkout
//     they started in.
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { dirname, isAbsolute, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
export const ROOT = join(HERE, '..', '..', '..')

function commonRoot() {
  try {
    const dir = execFileSync('git', ['rev-parse', '--git-common-dir'], {
      cwd: ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
    }).trim()
    return dirname(isAbsolute(dir) ? dir : resolve(ROOT, dir))
  } catch {
    return ROOT
  }
}

export const MAIN_ROOT = commonRoot()
export const LOOP_DIR = join(MAIN_ROOT, '.loop')
export const RUN_LOCK = join(LOOP_DIR, 'run.lock')
export const STOP_FILE = join(LOOP_DIR, 'stop')
export const HEAVY_LOCK = join(LOOP_DIR, 'heavy.lock')
export const WORKTREES_DIR = join(MAIN_ROOT, '.claude', 'worktrees')
export const LOOP_DOCS = join(ROOT, 'docs', 'build-loop')
export const RUNS_DIR = join(LOOP_DOCS, 'runs')
export const COSTS_FILE = join(LOOP_DOCS, 'costs.json')
export const LESSONS_FILE = join(LOOP_DOCS, 'lessons.md')
export const PROJECT_CONFIG = join(ROOT, '.claude', 'workflows', 'loop.config.json')

const strip = (raw) =>
  Object.fromEntries(
    Object.entries(raw).filter(([key]) => key !== 'note' && !key.endsWith('Why')),
  )

export function loopConfig() {
  const defaults = strip(JSON.parse(readFileSync(join(HERE, 'loop.defaults.json'), 'utf8')))
  const project = existsSync(PROJECT_CONFIG)
    ? strip(JSON.parse(readFileSync(PROJECT_CONFIG, 'utf8')))
    : {}
  return { ...defaults, ...project, configured: existsSync(PROJECT_CONFIG) }
}

// Words that only start another program: env assignments, shells, package
// managers and language runners. Taken off the front of a command and of a
// pattern alike, so `FOO=1 pnpm exec playwright test`, `npx playwright test`
// and `playwright test` all read as `playwright test`.
const RUNNER =
  /^(\w+=\S*\s+|(sh|bash|zsh)\s+-c\s+["']?|(pnpm|npm|yarn|bun)\s+(exec|run|dlx|x)\s+|(pnpm|yarn|bun)\s+(?!add\b|install\b|remove\b)|npx\s+|bunx\s+|tsx\s+|node\s+|deno\s+run\s+(-\S+\s+)*|(uv|poetry|pipenv|hatch|pdm|rye)\s+run\s+|bundle\s+exec\s+|python3?\s+-m\s+|python3?\s+|\.\/)/

export function bare(command) {
  let text = command.trim()
  for (let previous = ''; previous !== text; ) {
    previous = text
    text = text.replace(RUNNER, '')
  }
  return text
}

/** Splits a shell command into the programs it runs, on ;, &&, || and |. */
export function segments(command) {
  return command.split(/;|&&|\|\||\|/).map(bare)
}

function startsWithAny(segment, patterns) {
  return patterns.some((pattern) => {
    const p = bare(pattern)
    return segment === p || segment.startsWith(`${p} `)
  })
}

/**
 * True when a shell command runs a heavy program itself. A command that only
 * mentions one (grep "playwright test", cat scripts/loop/checks.mjs) is not
 * heavy: matching the text alone refuses read-only commands.
 */
export function invokesHeavy(command, config = loopConfig()) {
  return segments(command).some((segment) => startsWithAny(segment, config.heavyCommands))
}

/** True when a command runs something only the approver may run. */
export function invokesOutward(command, config = loopConfig()) {
  return segments(command).some((segment) =>
    startsWithAny(segment, config.approverCommands),
  )
}

const escape = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')

/** True when a command touches a protected branch, production, or anything no loop agent may run. */
export function invokesForbidden(command, config = loopConfig()) {
  const branches = (config.protectedBranches ?? []).map(escape).join('|')
  const patterns = [
    ...config.forbiddenPatterns,
    ...(branches
      ? [
          `git push[^;&|]*\\s(HEAD:|refs/heads/)?(${branches})\\b`,
          `gh pr create[^;&|]*--base[ =](${branches})\\b`,
          `git (checkout|switch)\\s+(${branches})\\b`,
        ]
      : []),
  ]
  if (patterns.some((pattern) => new RegExp(pattern).test(command))) return true
  return segments(command).some((segment) =>
    startsWithAny(segment, config.forbiddenCommands),
  )
}

/** True when a process's command line starts a server, a browser or a full build. */
export function isHeavy(command, config = loopConfig()) {
  return config.heavyCommands.some(
    (pattern) => command.includes(pattern) || command.includes(bare(pattern)),
  )
}

export function alive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
