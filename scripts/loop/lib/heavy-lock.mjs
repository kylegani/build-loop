// One heavy process on the machine at a time. checks.mjs and shoot.mjs take
// this lock, and a project can take it in its own e2e runner (see the README),
// so test suites, screenshots and builds never run beside each other, whoever
// starts them. A second one refuses to start and says who holds the lock,
// instead of piling another server on the machine.
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { HEAVY_LOCK, LOOP_DIR, alive } from './loop-config.mjs'

// A process started by the lock's holder (an e2e runner the check script
// starts) runs under its parent's lock instead of refusing.
const PARENT = Number(process.env.LOOP_HEAVY_LOCK_PARENT) || null

const holderOf = () => {
  try {
    const holder = JSON.parse(readFileSync(HEAVY_LOCK, 'utf8'))
    return holder.pid !== process.pid && holder.pid !== PARENT && alive(holder.pid) ? holder : null
  } catch {
    return null
  }
}

/**
 * Takes the lock for `what`. While a live process holds it, waits up to
 * `waitMs` (default none), then exits with code 2 and says who holds it.
 */
export function takeHeavyLock(what, { waitMs = 0 } = {}) {
  const until = Date.now() + waitMs
  while (holderOf() && Date.now() < until)
    Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5000)
  if (PARENT && alive(PARENT)) return
  if (existsSync(HEAVY_LOCK)) {
    const holder = holderOf()
    if (holder) {
      console.error(
        `${holder.what} (process ${holder.pid}) is using the machine since ${holder.since}. Wait for it to finish; don't start ${what} beside it.`,
      )
      process.exit(2)
    }
  }
  mkdirSync(LOOP_DIR, { recursive: true })
  writeFileSync(
    HEAVY_LOCK,
    JSON.stringify({ what, pid: process.pid, since: new Date().toISOString() }),
  )
  process.env.LOOP_HEAVY_LOCK_PARENT = String(process.pid)
  process.on('exit', releaseHeavyLock)
  process.on('SIGINT', () => process.exit(130))
  process.on('SIGTERM', () => process.exit(143))
}

/** Gives the lock back if this process holds it. */
export function releaseHeavyLock() {
  try {
    const holder = JSON.parse(readFileSync(HEAVY_LOCK, 'utf8'))
    if (holder.pid === process.pid) rmSync(HEAVY_LOCK)
  } catch {
    // already gone
  }
}
