// An owned folder whose reconcile pass never settles: the recursive readdir at the top of walkDisk
// parks and never returns. That is the honest shape of the production hazard — a share on an
// unresponsive network mount stops one layer below the promise, in a blocking syscall Bare gives no
// way to cancel, which is precisely why detect-and-re-arm is the only mechanism left.
//
// The test holds every parked read and releases them itself, which is what makes the ordering
// exact: a zombie pass can be made to unpark LONG after the recovery that abandoned it.
import fs from 'bare-fs'
import { setupOwnedShare } from './owned.js'
import { Supervisor } from '../../src/shared/core/supervisor.js'
import { periodicReconcile } from '../../src/shared/folders/owned-folders.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

export const delay = (ms) => new Promise((r) => setTimeout(r, ms))

export async function waitUntil (pred, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (pred()) return
    await delay(10)
  }
  throw new Error('condition not met within ' + ms + 'ms')
}

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }

export async function wedgedScan (t, { stallWindowMs = 150, files = { 'a.txt': 'one', 'b.txt': 'two' } } = {}) {
  const ctx = await setupOwnedShare(t, { files })
  // A probe interval long enough that only the explicit probe() calls in the test drive the policy.
  setRuntimeConfig({ ...getRuntimeConfig(), reconcileStallWindowMs: stallWindowMs, supervisionProbeIntervalMs: 3_600_000 })

  const origReaddir = fs.promises.readdir
  const parked = []
  const scans = { started: 0 }
  fs.promises.readdir = (dir, opts) => {
    if (dir !== ctx.mountPath) return origReaddir(dir, opts)
    scans.started += 1
    return new Promise((resolve, reject) => parked.push({ dir, opts, resolve, reject }))
  }
  // Lets the oldest parked walk finish for real, so the pass it belongs to runs its own tail.
  const release = () => {
    const one = parked.shift()
    if (!one) return false
    origReaddir(one.dir, one.opts).then(one.resolve, one.reject)
    return true
  }
  t.teardown(() => {
    fs.promises.readdir = origReaddir
    while (release()) {}
  })

  const owned = ctx.root.ownedFolders
  const supervisor = new Supervisor('supervision', { lifecycle: { started: [owned] } })
  supervisor.log = silentLog
  await supervisor.ready()
  t.teardown(() => supervisor.close())

  return {
    ...ctx,
    shareId: ctx.share.id,
    passKey: ctx.spaceId + ':' + ctx.share.id,
    owned,
    supervisor,
    scans,
    release,
    // Never awaited by the caller: it is the pass that does not settle. The catch keeps an
    // abandoned one from surfacing as an unhandled rejection when the process tears down.
    startScan: () => {
      const pass = periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
      pass.catch(() => {})
      return pass
    },
  }
}
