#!/usr/bin/env node
// Facts about the repo for the build-loop skill's setup. Reads manifests,
// lockfiles, scripts, CI workflows, docs and git, and prints them as JSON. It
// decides nothing: the agent running setup reads this, asks what only the
// owner can answer, and writes .claude/workflows/loop.config.json.
//
//   node scripts/loop/detect.mjs
import { execFileSync } from 'node:child_process'
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join } from 'node:path'
import { ROOT } from './lib/loop-config.mjs'

const has = (path) => existsSync(join(ROOT, path))
const read = (path) => (has(path) ? readFileSync(join(ROOT, path), 'utf8') : '')
const git = (...args) => {
  try {
    return execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return ''
  }
}
const which = (cmd) => {
  try {
    execFileSync('sh', ['-c', `command -v ${cmd}`], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
const list = (dir) => (has(dir) ? readdirSync(join(ROOT, dir)) : [])

const LOCKFILES = {
  'pnpm-lock.yaml': { manager: 'pnpm', install: 'pnpm install --frozen-lockfile --prefer-offline' },
  'package-lock.json': { manager: 'npm', install: 'npm ci' },
  'yarn.lock': { manager: 'yarn', install: 'yarn install --immutable' },
  'bun.lockb': { manager: 'bun', install: 'bun install --frozen-lockfile' },
  'bun.lock': { manager: 'bun', install: 'bun install --frozen-lockfile' },
  'uv.lock': { manager: 'uv', install: 'uv sync --frozen' },
  'poetry.lock': { manager: 'poetry', install: 'poetry install --no-root' },
  'Pipfile.lock': { manager: 'pipenv', install: 'pipenv sync --dev' },
  'Gemfile.lock': { manager: 'bundler', install: 'bundle install' },
  'go.sum': { manager: 'go', install: 'go mod download' },
  'Cargo.lock': { manager: 'cargo', install: 'cargo fetch' },
  'composer.lock': { manager: 'composer', install: 'composer install' },
  'mix.lock': { manager: 'mix', install: 'mix deps.get' },
}
const lockfiles = Object.keys(LOCKFILES).filter(has)

const manifests = [
  'package.json', 'pyproject.toml', 'requirements.txt', 'Pipfile', 'go.mod', 'Cargo.toml',
  'Gemfile', 'composer.json', 'mix.exs', 'pom.xml', 'build.gradle', 'build.gradle.kts',
  'Package.swift', 'pubspec.yaml', 'deno.json',
].filter(has)

// Installed versions from package.json and the lockfile's resolved versions
// where they are cheap to read; the agent reads other ecosystems' manifests.
let node = null
if (has('package.json')) {
  const pkg = JSON.parse(read('package.json'))
  const installed = (name) => {
    try {
      return JSON.parse(read(join('node_modules', name, 'package.json'))).version
    } catch {
      return null
    }
  }
  const deps = (block) =>
    Object.entries(pkg[block] ?? {}).map(([name, range]) => ({ name, range, installed: installed(name) }))
  node = {
    name: pkg.name ?? null,
    workspaces: pkg.workspaces ?? (has('pnpm-workspace.yaml') ? read('pnpm-workspace.yaml') : null),
    engines: pkg.engines ?? null,
    scripts: pkg.scripts ?? {},
    dependencies: deps('dependencies'),
    devDependencies: deps('devDependencies'),
  }
}

const ciFiles = [
  ...list('.github/workflows').map((f) => `.github/workflows/${f}`),
  ...['.gitlab-ci.yml', '.circleci/config.yml', 'azure-pipelines.yml', 'bitbucket-pipelines.yml', 'Jenkinsfile', '.buildkite/pipeline.yml'].filter(has),
].filter((f) => /\.(ya?ml)$|Jenkinsfile$/.test(f))
const ci = ciFiles.map((file) => {
  const text = read(file)
  const runs = [...text.matchAll(/^\s*(?:-\s*)?run:\s*(?:\|\s*\n)?(.+)$/gm)].map((m) => m[1].trim()).slice(0, 40)
  return { file, on: (text.match(/^on:\s*([\s\S]*?)^\w/m)?.[1] ?? '').trim().slice(0, 300), runs }
})

const docCandidates = [
  'CLAUDE.md', 'AGENTS.md', 'CONTRIBUTING.md', 'README.md', 'ARCHITECTURE.md', 'DESIGN.md',
  'PRODUCT.md', 'STYLEGUIDE.md', '.cursorrules', '.github/copilot-instructions.md',
].filter(has)
const docFolders = ['docs', '.agents', '.agents/context', 'doc', 'documentation', 'adr', 'docs/adr']
  .filter((d) => has(d) && statSync(join(ROOT, d)).isDirectory())
  .map((d) => ({ dir: d, files: list(d).filter((f) => /\.mdx?$/.test(f)).slice(0, 60) }))

const remote = git('remote', 'get-url', 'origin')
const defaultBranch = git('symbolic-ref', '--short', 'refs/remotes/origin/HEAD').replace(/^origin\//, '')
const remoteBranches = git('branch', '-r', '--format=%(refname:short)')
  .split('\n')
  .map((b) => b.replace(/^origin\//, ''))
  .filter((b) => b && b !== 'origin' && b !== 'HEAD')

const e2e = {
  playwright: ['playwright.config.ts', 'playwright.config.js', 'playwright.config.mjs'].find(has) ?? null,
  cypress: ['cypress.config.ts', 'cypress.config.js'].find(has) ?? null,
  savedSessions: ['.auth', 'playwright/.auth', 'e2e/.auth'].filter(has).flatMap((d) => list(d).map((f) => `${d}/${f}`)),
}

const migrationDirs = ['migrations', 'drizzle', 'prisma/migrations', 'db/migrate', 'alembic/versions', 'supabase/migrations', 'src/migrations']
  .filter(has)

const envFiles = list('.').filter((f) => /^\.env(\..+)?$/.test(f) && !/\.example$|\.sample$|\.template$/.test(f))

console.info(
  JSON.stringify(
    {
      root: ROOT,
      git: {
        remote,
        github: /github\.com[:/]/.test(remote),
        defaultBranch: defaultBranch || null,
        integrationBranches: remoteBranches.filter((b) => /^(staging|develop|dev|next|preview)$/.test(b)),
        ghInstalled: which('gh'),
      },
      manifests,
      lockfiles: lockfiles.map((f) => ({ file: f, ...LOCKFILES[f] })),
      node,
      ci,
      docs: { files: docCandidates, folders: docFolders },
      e2e,
      migrationDirs,
      envFiles,
      alreadyConfigured: has('.claude/workflows/loop.config.json'),
      skills: list('.claude/skills'),
    },
    null,
    2,
  ),
)
