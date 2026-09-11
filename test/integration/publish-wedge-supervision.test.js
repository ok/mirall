import test from 'brittle'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { Supervisor } from '../../src/shared/core/supervisor.js'
import { initialPublishScan, getIndexStatus } from '../../src/shared/folders/owned-folders.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { scaled } from '../helpers/bare-timing.js'

// The publish lane is shared by every space, so a wedged item is not one share's problem: at the
// shipped concurrency three of them stop publishing everywhere, with no crash and nothing in the
// log. The wedge is staged where the production one happens — the streaming read of the file,
// which on an unresponsive mount is a syscall no deadline can interrupt.

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }
const delay = (ms) => new Promise((r) => setTimeout(r, ms))

async function waitUntil(pred, ms = 5000) {
  const deadline = Date.now() + scaled(ms)
  while (Date.now() < deadline) {
    if (pred()) return
    await delay(10)
  }
  throw new Error('condition not met within ' + scaled(ms) + 'ms')
}

async function wedgedPublish(t) {
  const ctx = await setupOwnedShare(t, { files: { 'first.bin': 'aaa', 'second.bin': 'bbb' } })
  setRuntimeConfig({
    ...getRuntimeConfig(),
    publishStallWindowMs: 150,
    supervisionProbeIntervalMs: 3_600_000,
    // One bulk slot, so the second file cannot start while the first holds it.
    publishConcurrency: 1,
  })

  const overlay = getOverlay()
  const orig = overlay.prepareForServe.bind(overlay)
  const parked = []
  const reads = []
  overlay.prepareForServe = (diskPath, opts) => {
    reads.push(path.basename(diskPath))
    return new Promise((resolve, reject) => parked.push({ diskPath, opts, resolve, reject }))
  }
  t.teardown(() => {
    overlay.prepareForServe = orig
    for (const one of parked.splice(0)) orig(one.diskPath, one.opts).then(one.resolve, one.reject)
  })

  const publishService = ctx.root.publishService
  const supervisor = new Supervisor('supervision', { lifecycle: { started: [publishService] } })
  supervisor.log = silentLog
  await supervisor.ready()
  t.teardown(() => supervisor.close())

  // Never awaited: its items are the ones that do not settle.
  initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []).catch(() => {})
  await waitUntil(() => reads.length === 1)
  return { ...ctx, shareId: ctx.share.id, publishService, supervisor, reads }
}

test('a publish item that stops advancing is reported as a supervisable unit', async (t) => {
  const w = await wedgedPublish(t)
  t.alike(w.publishService.supervise(), [], 'an item that just started is not a unit that needs anything')

  await waitUntil(() => w.publishService.supervise()[0]?.ok === false)
  const [row] = w.publishService.supervise()
  t.ok(row.key.includes(w.reads[0]), 'the unit is one item, keyed by share and path')
  t.is(row.label, w.shareId + ' ' + w.reads[0], 'and the log-safe label names both')
  t.ok(row.detail.startsWith('no progress for'))
})

test('the redacted health report counts the wedge and names nothing', async (t) => {
  const w = await wedgedPublish(t)
  await waitUntil(() => w.publishService.supervise()[0]?.ok === false)

  const health = w.publishService.health()
  t.is(health.ok, false)
  t.is(health.publishes.wedged, 1)
  const serialised = JSON.stringify(health)
  t.absent(serialised.includes(w.spaceId), 'no space id reaches the shareable bundle')
  t.absent(serialised.includes(w.shareId), 'and no share id either')
})

// REGRESSION (FIX-PUBLISH-WEDGE: an item whose executor never returned held its slot forever. At
// the shipped concurrency three of those stopped publishing for EVERY space until the app was
// restarted; health() said ok and nothing was logged.)
test('REGRESSION (FIX-PUBLISH-WEDGE): the wedged item\'s slot is reclaimed and the lane resumes', async (t) => {
  const w = await wedgedPublish(t)
  await waitUntil(() => w.publishService.supervise()[0]?.ok === false)
  t.is(w.reads.length, 1, 'the second file cannot start while the first holds the only slot')

  await w.supervisor.probe()
  t.is(w.reads.length, 1, 'one bad probe is not enough to act')
  await w.supervisor.probe()

  await waitUntil(() => w.reads.length === 2, 3000)
  t.is(w.supervisor.stats().recoveries.publish, 1, 'the recovery is counted by subsystem')

  const status = getIndexStatus(w.spaceId, w.shareId)
  t.is(status.stalled, 1, 'the evicted item holds no slot and has not returned')
  t.is(status.running, 1, 'and the slot it freed went to the file that was waiting')
})

test('an evicted path is never handed a second executor', async (t) => {
  const w = await wedgedPublish(t)
  await waitUntil(() => w.publishService.supervise()[0]?.ok === false)
  await w.supervisor.probe()
  await w.supervisor.probe()
  await waitUntil(() => w.reads.length === 2, 3000)

  // The same file the recovery evicted, requested again: the queue still owns its path, so this
  // supersedes into one rerun rather than starting a second read of a file already being read.
  initialPublishScan(w.spaceId, w.shareId, w.mountPath, []).catch(() => {})
  await delay(200)
  t.is(w.reads.filter((name) => name === w.reads[0]).length, 1, 'the path was read exactly once')
})
