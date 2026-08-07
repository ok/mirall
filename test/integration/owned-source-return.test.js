import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { initOwnedFolders, onFsEvent } from '../../src/shared/folders/owned-folders.js'
import { setOwnedMountStatus, getOwnedMount } from '../../src/shared/folders/mount-store.js'

// A watcher event schedules a trailing catch-up reconcile (2s debounce). That reconcile used to
// run fire-and-forget: it healed the catalog but its OUTCOME went nowhere, so nothing persisted a
// status and nothing emitted event:owned-folder-mount-status. The renderer only re-derives the
// owned-mount status on that event, and the 60s mount-point probe only emits on a present↔gone
// EDGE — so a source folder that vanished and came back inside one probe window produced no
// signal at all and the "source folder moved" banner stayed up forever (frontend s79).

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const CATCHUP_SETTLED_MS = 4000   // POST_EVENT_RECONCILE_MS (2s) plus room for the scan itself

// Stand-in for the worker's settleScanStatus: records every settled outcome and applies the same
// outcome → status mapping (durable write + live event) the worker installs in production.
function recordingSettle (ctx) {
  const settled = []
  const settleScan = async (scan, spaceId, shareId) => {
    let status = 'active'
    let outcome
    try {
      const result = await scan
      if (result?.skipped === 'mount-point-gone') status = 'mount-point-gone'
      else if (result?.skipped) status = 'paused-error'
      outcome = { spaceId, shareId, result }
    } catch (err) {
      status = 'paused-error'
      outcome = { spaceId, shareId, error: err }
    }
    await setOwnedMountStatus(spaceId, shareId, status, null)
    ctx.fake.ipc.emit('event:owned-folder-mount-status', { spaceId, shareId, status })
    // Recorded last: waitForSettle keys off this array, so publishing the status first keeps
    // the assertions that follow it free of a race with our own settle.
    settled.push(outcome)
  }
  initOwnedFolders(ctx.fake.ipc, { settleScan })
  return settled
}

// Returns whether an outcome landed. Callers bail out on false: with nothing recorded, every
// assertion after it would throw on an empty array and bury the real failure.
async function waitForSettle (settled, timeout = CATCHUP_SETTLED_MS) {
  const deadline = Date.now() + timeout
  while (Date.now() < deadline && settled.length === 0) await delay(50)
  return settled.length > 0
}

test('REGRESSION (FIX-S79: a watcher event’s catch-up reconcile settles its outcome)', async (t) => {
  const ctx = await setupOwnedShare(t)
  const settled = recordingSettle(ctx)

  const abs = path.join(ctx.mountPath, 'doc.txt')
  fs.writeFileSync(abs, 'v1')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'doc.txt', abs)

  const landed = await waitForSettle(settled)
  t.ok(landed, 'the trailing catch-up reconcile reported its outcome')
  if (!landed) return
  t.is(settled[0].shareId, ctx.share.id, 'settled against the share that saw the event')
  t.absent(settled[0].result?.skipped, 'a present root reconciles for real')
  t.is(ctx.fake.lastStatus(ctx.share.id), 'active', 'and the UI is told the mount is healthy')
})

// The s79 timeline at the data layer: the source vanishes (watcher unlink), the banner goes up,
// and the folder is restored moments later — well inside one probe window, so the probe never
// sees an edge. The catch-up reconcile is the only thing that can clear it.
test('REGRESSION (FIX-S79: a source restored before the catch-up reconcile clears the gone status)', async (t) => {
  const ctx = await setupOwnedShare(t)
  const settled = recordingSettle(ctx)
  const abs = path.join(ctx.mountPath, 'doc.txt')
  fs.writeFileSync(abs, 'v1')

  // Source folder moved away: the watcher fires unlink against an absent root.
  fs.rmSync(ctx.mountPath, { recursive: true, force: true })
  await onFsEvent(ctx.spaceId, ctx.share.id, 'unlink', 'doc.txt', abs)
  t.is(ctx.fake.lastStatus(ctx.share.id), 'mount-point-gone', 'the missing source surfaces immediately')

  // Moved back, before the 2s catch-up reconcile fires.
  fs.mkdirSync(ctx.mountPath, { recursive: true })
  fs.writeFileSync(abs, 'v1')

  const landed = await waitForSettle(settled)
  t.ok(landed, 'the catch-up reconcile still settles after the round trip')
  if (!landed) return
  t.absent(settled[0].result?.skipped, 'it ran against the restored root')
  t.is(ctx.fake.lastStatus(ctx.share.id), 'active', 'the gone status is cleared without a probe edge')
  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'active', 'and the durable status recovers')
})

// The other half: when the source is STILL gone at catch-up time, the settled outcome is what
// drives the durable gone status — and, in the worker, marks the probe's presence baseline so the
// eventual return registers as a gone→present edge.
test('REGRESSION (FIX-S79: a source still missing at catch-up time settles as mount-point-gone)', async (t) => {
  const ctx = await setupOwnedShare(t)
  const settled = recordingSettle(ctx)
  const abs = path.join(ctx.mountPath, 'doc.txt')
  fs.writeFileSync(abs, 'v1')

  fs.rmSync(ctx.mountPath, { recursive: true, force: true })
  await onFsEvent(ctx.spaceId, ctx.share.id, 'unlink', 'doc.txt', abs)

  const landed = await waitForSettle(settled)
  t.ok(landed, 'the catch-up reconcile reports even when it could not run')
  if (!landed) return
  t.is(settled[0].result?.skipped, 'mount-point-gone', 'the outcome names the missing root')
  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'mount-point-gone', 'persisted, so a reload re-derives it')
})
