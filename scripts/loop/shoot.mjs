#!/usr/bin/env node
// Screenshots for the build loop's UI gate and design previews. Shoots each
// screen at every width and theme in the `screens` settings, signed in as the
// role that sees it, under the machine's heavy lock.
//
//   node scripts/loop/shoot.mjs --routes "/settings as admin,/ as anonymous"
//
// Roles are the keys of screens.roles; each maps to a Playwright storage
// state file (a saved session) or null for signed out. When nothing answers at
// screens.baseUrl and screens.start is set, it starts the server, waits for
// it, and stops it after.
//
// When screens.command is set, that command is run instead, with LOOP_SHOTS
// (the routes as JSON) and LOOP_SHOTS_OUT (the folder) in its environment; it
// must write report.json there in the shape below.
//
// Prints { ok, out, shots: [file], problems: [text] }: a page that answers
// with an error status, logs a browser error or scrolls sideways is a
// problem, and the UI gate reports each one.
import { spawn, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { createRequire } from 'node:module'
import { join } from 'node:path'
import { takeHeavyLock } from './lib/heavy-lock.mjs'
import { LOOP_DIR, ROOT, loopConfig } from './lib/loop-config.mjs'

const arg = (name) => {
  const i = process.argv.indexOf(`--${name}`)
  return i === -1 ? undefined : process.argv[i + 1]
}
// out() exits the process, so it stops a server this script started first.
let server = null
const stopServer = () => {
  if (!server) return
  try {
    process.kill(-server.pid, 'SIGTERM')
  } catch {
    // already gone
  }
  server = null
}
const out = (value) => {
  stopServer()
  console.info(JSON.stringify(value, null, 2))
  process.exit(0)
}
const config = loopConfig()
const screens = config.screens
if (!screens) out({ ok: false, reason: 'This project has no screens setting, so there is nothing to shoot.' })
const roles = screens.roles ?? { anonymous: null }
const firstRole = Object.keys(roles)[0] ?? 'anonymous'
const routes = (arg('routes') ?? '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean)
  .map((entry) => {
    const [path, role] = entry.split(/\s+as\s+/)
    return { path: path.trim(), role: (role ?? firstRole).trim() }
  })
if (!routes.length) out({ ok: false, reason: 'Pass --routes "/path as role,...".' })
const unknown = routes.filter((r) => !(r.role in roles))
if (unknown.length)
  out({
    ok: false,
    reason: `Unknown roles: ${[...new Set(unknown.map((r) => r.role))].join(', ')}. Known: ${Object.keys(roles).join(', ')}.`,
  })

const dir = arg('out') ?? join(LOOP_DIR, 'shots')
rmSync(dir, { recursive: true, force: true })
mkdirSync(dir, { recursive: true })
takeHeavyLock('loop screenshots', { waitMs: 8 * 60 * 1000 })

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const answers = async (url) => {
  try {
    await fetch(url, { signal: AbortSignal.timeout(5000) })
    return true
  } catch {
    return false
  }
}

async function builtIn() {
  const require = createRequire(join(ROOT, 'package.json'))
  let chromium
  for (const name of ['playwright', '@playwright/test', 'playwright-core']) {
    try {
      chromium = require(name).chromium
      break
    } catch {
      // try the next one
    }
  }
  if (!chromium)
    out({
      ok: false,
      reason:
        "Playwright isn't installed in this repo, so the built-in screenshots can't run. Install it, or set screens.command to the project's own screenshot command.",
    })
  const widths = screens.widths ?? [1440, 375]
  const themes = screens.themes ?? ['light', 'dark']
  const browser = await chromium.launch()
  const report = []
  try {
    for (const route of routes)
      for (const width of widths)
        for (const theme of themes) {
          const context = await browser.newContext({
            storageState: roles[route.role] ? join(ROOT, roles[route.role]) : undefined,
            viewport: { width, height: width < 600 ? 812 : 900 },
            colorScheme: theme === 'dark' ? 'dark' : 'light',
          })
          if (screens.themeCookie)
            await context.addCookies([{ name: screens.themeCookie, value: theme, url: screens.baseUrl }])
          const page = await context.newPage()
          const errors = []
          page.on('console', (m) => m.type() === 'error' && errors.push(m.text().slice(0, 300)))
          page.on('pageerror', (e) => errors.push(e.message.slice(0, 300)))
          let status = null
          try {
            const response = await page.goto(new URL(route.path, screens.baseUrl).href)
            status = response?.status() ?? null
            await page.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {})
          } catch (error) {
            errors.push(String(error.message).slice(0, 300))
          }
          const sidewaysScroll = await page
            .evaluate(() => document.documentElement.scrollWidth > window.innerWidth + 1)
            .catch(() => false)
          const file = join(
            dir,
            `${route.role}${route.path.replace(/[^\w]+/g, '-').replace(/-$/, '') || '-home'}-${width}-${theme}.png`,
          )
          await page.screenshot({ path: file, animations: 'disabled' }).catch(() => {})
          report.push({ path: route.path, role: route.role, width, theme, file, status, errors, sidewaysScroll })
          await context.close()
        }
  } finally {
    await browser.close()
  }
  writeFileSync(join(dir, 'report.json'), JSON.stringify(report, null, 2))
}

try {
  if (screens.command) {
    const r = spawnSync(screens.command, {
      cwd: ROOT,
      shell: true,
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
      env: { ...process.env, LOOP_SHOTS: JSON.stringify(routes), LOOP_SHOTS_OUT: dir },
    })
    if (!existsSync(join(dir, 'report.json')))
      out({ ok: false, reason: `No screenshots were taken. The command said:\n${`${r.stdout}${r.stderr}`.slice(-2000)}` })
  } else {
    if (!(await answers(screens.baseUrl))) {
      if (!screens.start)
        out({ ok: false, reason: `Nothing answers at ${screens.baseUrl} and screens.start isn't set.` })
      server = spawn(screens.start, { cwd: ROOT, shell: true, detached: true, stdio: 'ignore' })
      const until = Date.now() + 180000
      while (!(await answers(screens.baseUrl)) && Date.now() < until) await sleep(2000)
      if (!(await answers(screens.baseUrl)))
        out({ ok: false, reason: `Started "${screens.start}" but nothing answered at ${screens.baseUrl} within 3 minutes.` })
    }
    await builtIn()
  }
} finally {
  stopServer()
}

const report = JSON.parse(readFileSync(join(dir, 'report.json'), 'utf8'))
const problems = report.flatMap((s) => [
  ...(s.status && s.status >= 400 ? [`${s.role} ${s.path} answered ${s.status}`] : []),
  ...(s.sidewaysScroll ? [`${s.role} ${s.path} scrolls sideways at ${s.width}px (${s.theme})`] : []),
  ...(s.errors ?? []).map((e) => `${s.role} ${s.path} at ${s.width}px (${s.theme}) logged: ${e}`),
])
out({ ok: true, out: dir, shots: report.map((s) => s.file), problems: [...new Set(problems)] })
