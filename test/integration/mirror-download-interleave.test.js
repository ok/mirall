import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import {
  materializeCatalogFile, runMaterializeTick, startForeignLoop, stopForeignLoop, restartForeignLoop, mirrorHealth,
} from '../../src/shared/folders/foreign-folders.js'
import {
  claimFetch, fetchClaimedBy, registerFetchOwner, resetFetchClaims, FETCH_OWNER_MIRROR,
} from '../../src/shared/transfer/backends/overlay/fetch-claims.js'
import { resetFetchSlots, fetchSlotStats, acquireFetchSlot } from '../../src/shared/transfer/backends/overlay/fetch-slots.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { transferIdFor } from '../../src/shared/transfer/transfer-id.js'
import { initPendingTransfers, listPendingForSpace } from '../../src/shared/transfer/pending-transfers.js'

// REGRESSION: the mirror and the folder engine could both fetch one file and both write its
// decoration key, so the mirror probed the FOLDER engine's registry defensively before every fetch
// and again on every settle. That probe answered for one engine instance out of two and knew
// nothing of a second mirror, which is why the two guards became one shared claim.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

async function until (fn, ms = 10000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(10)
  }
  return false
}

async function mirrorCtx (t, opts = {}) {
  const ctx = await setupSelfMirror(t, opts)
  await initPendingTransfers()
  const prev = getRuntimeConfig()
  resetFetchSlots()
  resetFetchClaims()
  t.teardown(() => { setRuntimeConfig(prev); resetFetchSlots(); resetFetchClaims() })
  return ctx
}

async function firstEntry (ctx) {
  const { entries } = await (await import('../../src/shared/transfer/content-backends.js'))
    .getContentBackend(ctx.share).listPeerWithMeta(ctx.spaceId, ctx.share)
  return entries[0]
}

function testChannel (over = {}) {
  return {
    diagLabel: 'test download',
    inPlace: false,
    ownsPendingRow: (row) => row.overlayShare === true,
    pendingExtra: (job) => ({ overlayShare: true, shareId: job.shareId, relPath: job.relPath }),
    emitProgress: () => {}, emitError: () => {}, emitComplete: () => {}, emitCancelled: () => {},
    emitSuperseded: () => {}, emitPaused: () => {}, emitUpdated: () => {}, emitDecorationDone: () => {},
    transferIdForRow: (spaceId, row) => spaceId + '|' + row.shareId + '|' + row.relPath,
    isOwnerOnline: () => true,
    ...over,
  }
}

test('a manual download and the mirror never both fetch one file', async (t) => {
  const ctx = await mirrorCtx(t)
  const entry = await firstEntry(ctx)
  const transferId = transferIdFor(ctx.spaceId, ctx.share.id, entry.relPath)

  // The engine got there first (the live direction: browse, download, then mirror the share).
  const live = new Set([transferId])
  registerFetchOwner('folder', (id) => live.has(id))

  let fetched = 0
  const overlay = getOverlay()
  const realFetch = overlay.fetchFile
  overlay.fetchFile = async (...args) => { fetched += 1; return await realFetch(...args) }
  t.teardown(() => { overlay.fetchFile = realFetch })

  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entry), 'missing', 'the mirror yields')
  t.is(fetched, 0, 'and never reached the vendor layer')
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, entry.relPath)), 'no duplicate bytes landed')

  live.delete(transferId)
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entry), 'present', 'the next tick lands it once the engine settles')
  t.is(fetched, 1, 'exactly one fetch across both producers')
})

test('a start() against a held claim records the pending row and returns the live transfer', async (t) => {
  const ctx = await mirrorCtx(t)
  const entry = await firstEntry(ctx)
  const transferId = transferIdFor(ctx.spaceId, ctx.share.id, entry.relPath)
  claimFetch(transferId, FETCH_OWNER_MIRROR)

  let started = 0
  const overlay = getOverlay()
  const realFetch = overlay.fetchFile
  overlay.fetchFile = async (...args) => { started += 1; return await realFetch(...args) }
  t.teardown(() => { overlay.fetchFile = realFetch })

  const engine = createOverlayDownloadEngine(testChannel())
  const finalPath = path.join(ctx.tmpDir('dl'), 'copy.bin')
  const res = await engine.start({
    spaceId: ctx.spaceId, pendingKey: '/dl/copy.bin', path: '/dl/copy.bin', relPath: entry.relPath,
    shareId: ctx.share.id, transferId, contentHash: entry.contentHash, size: entry.size,
    ownerPublicKey: ctx.share.owner, verifyKey: ctx.share.id + '|' + entry.relPath, finalPath,
  })

  // Refusing outright would leave the click with no transferId to follow and no bar — the failure
  // this attach path exists to avoid.
  t.is(res.transferId, transferId, 'the caller gets a transfer to follow')
  t.is(started, 0, 'no second fetch was started')
  t.absent(engine.has(transferId), 'and the engine did not reserve a registry slot')

  const pending = await listPendingForSpace(ctx.spaceId)
  t.ok(pending.some((row) => row.filePath === '/dl/copy.bin'), 'the intent is durable, so a later reconcile re-drives this destination')
})

// The deliberate third call site. share-listing asks "is the FOLDER engine fetching this" for a
// browse row, which is a different question from "is anyone fetching this" — and a browse listing
// has no mirror by construction. Pinned so a later sweep does not finish the job.
test('a browse listing still reads isActive from the folder engine', (t) => {
  const src = fs.readFileSync(new URL('../../src/shared/shares/share-listing.js', import.meta.url).pathname, 'utf8')
  t.ok(/isActive: deps\.overlayHasTransfer\(transferId\)/.test(src), 'the browse row still probes the engine directly')
  t.absent(/fetch-claims/.test(src), 'and does not ask the claim registry')
})

test('the mirror releases its claim and its slot on every exit path', async (t) => {
  const ctx = await mirrorCtx(t, { files: { 'a.txt': 'aaa', 'b.txt': 'bbbb' } })
  const entries = []
  const backend = await import('../../src/shared/transfer/content-backends.js')
  const listed = await backend.getContentBackend(ctx.share).listPeerWithMeta(ctx.spaceId, ctx.share)
  entries.push(...listed.entries)

  const overlay = getOverlay()
  const realFetch = overlay.fetchFile

  // done
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entries[0]), 'present')
  t.is(fetchSlotStats().held, 0, 'slot released after a completed fetch')
  t.is(fetchClaimedBy(transferIdFor(ctx.spaceId, ctx.share.id, entries[0].relPath)), null, 'claim released')

  // miss (fetchFile resolves null)
  overlay.fetchFile = async () => null
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entries[1]), 'missing')
  t.is(fetchSlotStats().held, 0, 'slot released after a miss')
  t.is(fetchClaimedBy(transferIdFor(ctx.spaceId, ctx.share.id, entries[1].relPath)), null, 'claim released after a miss')

  // error
  overlay.fetchFile = async () => { throw new Error('boom') }
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entries[1]), 'missing')
  t.is(fetchSlotStats().held, 0, 'slot released after a throw')
  t.is(fetchClaimedBy(transferIdFor(ctx.spaceId, ctx.share.id, entries[1].relPath)), null, 'claim released after a throw')

  overlay.fetchFile = realFetch
})

// Hazard 3. A pass parked on the gate is 'in flight' as far as pass-liveness is concerned, and the
// wait is unbounded — so stamping progress either side of it is not enough on its own. The
// heartbeat is what keeps mirrorVerdict measuring the fetch instead of the queue.
test('waiting for a slot counts as mirror progress', async (t) => {
  const ctx = await mirrorCtx(t)
  const prev = getRuntimeConfig()
  // A 60 ms poll makes the stall window 60 x STALL_FACTOR (20) = 1.2 s of real time.
  setRuntimeConfig({ ...prev, downloadConcurrency: 1, foreignPollIntervalMs: 60 })

  const hog = await acquireFetchSlot({})
  await startForeignLoop(ctx.mount)
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id))

  runMaterializeTick(ctx.spaceId, ctx.share.id).catch(() => {})
  t.ok(await until(() => fetchSlotStats().queued === 1), 'the pass is parked behind the hogged slot')

  // Past the window: without the heartbeat this reports stalled and the Supervisor restarts it.
  await sleep(1500)
  const [health] = mirrorHealth()
  t.ok(health, 'the mirror is supervised')
  t.ok(health.ok, 'a queued mirror is not a wedged one: ' + (health.detail || ''))

  hog()
  await settleTick()
  async function settleTick () { await until(() => fetchSlotStats().queued === 0) }
})

// REGRESSION: the claim is released from the fetch's finally, which a WEDGED pass never reaches.
// restartForeignLoop exists to recover exactly that mount, and it was refused by the dead claim of
// the pass it had just abandoned — so the file was never fetched again this lifetime.
test('a restart drops the abandoned pass claim so the mount can be recovered', async (t) => {
  const ctx = await mirrorCtx(t)
  const entry = await firstEntry(ctx)
  const transferId = transferIdFor(ctx.spaceId, ctx.share.id, entry.relPath)

  const overlay = getOverlay()
  const realFetch = overlay.fetchFile
  const realCancel = overlay.cancelFetch
  let fetches = 0
  // A fetch that never settles on its own, exactly like test/helpers/wedged-mirror.js: the test
  // holds the rejecters and settles them in teardown, or stopForeignLoop awaits a dead promise.
  const rejecters = []
  overlay.fetchFile = () => { fetches += 1; return new Promise((_res, rej) => rejecters.push(rej)) }
  overlay.cancelFetch = () => true
  t.teardown(async () => {
    for (const rej of rejecters.splice(0)) rej(Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }))
    await sleep(50)
    overlay.fetchFile = realFetch
    overlay.cancelFetch = realCancel
  })

  await startForeignLoop(ctx.mount)
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id, { discardPartial: true }))
  runMaterializeTick(ctx.spaceId, ctx.share.id).catch(() => {})
  t.ok(await until(() => fetches === 1), 'the first pass wedged inside the fetch')
  t.is(fetchClaimedBy(transferId), FETCH_OWNER_MIRROR, 'holding the claim')

  await restartForeignLoop(ctx.spaceId, ctx.share.id)
  t.ok(await until(() => fetches === 2), 'the restarted pass fetched instead of yielding to the zombie')
})
