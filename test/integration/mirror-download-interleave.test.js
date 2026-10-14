import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/overlay/index.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/overlay/overlay-download.js'
import { mirrorHealth } from '../../src/shared/folders/foreign-folders.js'
import { startForeignLoop, stopForeignLoop, restartForeignLoop } from '../../src/shared/folders/foreign-verbs.js'
import { materializeCatalogFile, runMaterializeTick } from '../../src/shared/folders/mirror-pass.js'
import {
  claimFetch, fetchClaimedBy, registerFetchOwner, resetFetchClaims,
} from '../../src/shared/transfer/overlay/fetch-gate.js'
import { resetFetchSlots, fetchSlotStats, acquireFetchSlot, drainFetchSlots, FETCH_OWNER_MIRROR } from '../../src/shared/transfer/overlay/fetch-gate.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { transferIdFor } from '../../src/shared/transfer/transfer-id.js'
import { shareDecoKey } from '../../src/shared/contract/decoration-key.js'
import { initPendingTransfers, listPendingForSpace } from '../../src/shared/transfer/pending-transfers.js'
import { until as pollUntil } from '../helpers/bare-poll.js'

// REGRESSION: the mirror and the download engine could both fetch one file and both write its
// decoration key, so the mirror probed the engine's registry defensively before every fetch and
// again on every settle. That probe answered for the engine alone and knew nothing of a second
// mirror, which is why the two guards became one shared claim.

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const until = (pred, ms = 10000) => pollUntil(pred, ms, { interval: 10 })

async function mirrorCtx(t, opts = {}) {
  const ctx = await setupSelfMirror(t, opts)
  await initPendingTransfers()
  const prev = getRuntimeConfig()
  resetFetchSlots()
  resetFetchClaims()
  t.teardown(() => { setRuntimeConfig(prev); resetFetchSlots(); resetFetchClaims() })
  return ctx
}

async function firstEntry(ctx) {
  const { entries } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  return entries[0]
}

function testChannel(over = {}) {
  return {
    diagLabelFor: () => 'test download',
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
    ownerKey: ctx.share.owner, verifyKey: ctx.share.id + '|' + entry.relPath, finalPath,
  })

  // Refusing outright would leave the click with no transferId to follow and no bar — the failure
  // this attach path exists to avoid.
  t.is(res.transferId, transferId, 'the caller gets a transfer to follow')
  t.is(started, 0, 'no second fetch was started')
  t.absent(engine.has(transferId), 'and the engine did not reserve a registry slot')

  const pending = await listPendingForSpace(ctx.spaceId)
  t.ok(pending.some((row) => row.filePath === '/dl/copy.bin'), 'the intent is durable, so a later reconcile re-drives this destination')
})

// The deliberate third call site. share-listing asks "is the download engine fetching this" for a
// browse row, which is a different question from "is anyone fetching this" — and a browse listing
// has no mirror by construction. Pinned so a later sweep does not finish the job.
test('a browse listing still reads isActive from the download engine', (t) => {
  const src = fs.readFileSync(new URL('../../src/shared/shares/share-listing.js', import.meta.url).pathname, 'utf8')
  t.ok(/isActive: deps\.hasTransfer\(transferIdFor\(/.test(src), 'the browse row still probes the engine directly')
  t.absent(/fetch-gate/.test(src), 'and does not ask the claim registry')
})

test('the mirror releases its claim and its slot on every exit path', async (t) => {
  const ctx = await mirrorCtx(t, { files: { 'a.txt': 'aaa', 'b.txt': 'bbbb' } })
  const entries = []
  const listed = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  entries.push(...listed.entries)

  const overlay = getOverlay()
  const realFetch = overlay.fetchFile

  // done
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entries[0]), 'present')
  t.is(fetchSlotStats().held, 0, 'slot released after a completed fetch')
  t.is(fetchClaimedBy(transferIdFor(ctx.spaceId, ctx.share.id, entries[0].relPath)), null, 'claim released')

  // miss (fetchFile resolves null with no scheduler end == no holder was ever reachable)
  overlay.fetchFile = async () => null
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entries[1]), 'no-peers')
  t.is(fetchSlotStats().held, 0, 'slot released after a miss')
  t.is(fetchClaimedBy(transferIdFor(ctx.spaceId, ctx.share.id, entries[1].relPath)), null, 'claim released after a miss')

  // error
  overlay.fetchFile = async () => { throw new Error('boom') }
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entries[1]), 'missing')
  t.is(fetchSlotStats().held, 0, 'slot released after a throw')
  t.is(fetchClaimedBy(transferIdFor(ctx.spaceId, ctx.share.id, entries[1].relPath)), null, 'claim released after a throw')

  overlay.fetchFile = realFetch
})

// The vendor's own throws are settled inside the fetch, so the case above never makes the gated half
// itself reject. A renderer channel that throws on the terminal decoration frame does: that frame is
// sent from the fetch's own cleanup, after the claim was taken and the vendor asked, and the slot
// and the claim must still come free.
test('a fault that escapes the fetch still releases the slot and the claim', async (t) => {
  const ctx = await mirrorCtx(t)
  const entry = await firstEntry(ctx)
  const overlay = getOverlay()
  const realFetch = overlay.fetchFile
  let fetches = 0
  overlay.fetchFile = async () => { fetches += 1; return null }
  t.teardown(() => { overlay.fetchFile = realFetch })
  const closed = new Error('the renderer channel is closed')
  const key = shareDecoKey(ctx.share.id, entry.relPath)
  const stopThrowing = ctx.fake.onEmit((frame) => {
    if (frame.type === 'event:decoration' && frame.payload?.key === key && frame.payload.done === true) throw closed
  })
  t.teardown(stopThrowing)

  let thrown = null
  try { await materializeCatalogFile(ctx.mount, ctx.share, entry) } catch (err) { thrown = err }
  t.is(thrown, closed, 'precondition: the fault left the gated half as a rejection')
  t.is(fetches, 1, 'after the vendor was asked under the claim')
  t.is(fetchSlotStats().held, 0, 'the slot was released')
  t.is(fetchClaimedBy(transferIdFor(ctx.spaceId, ctx.share.id, entry.relPath)), null, 'and no claim was left behind')
})

// ForeignMirrors' close drains only the mirror's waiters, then stops every loop in the same turn. A
// parked pass must be among the drained ones, and must resume into its stop rather than a fetch.
test('closing the mirror resumes its parked pass into the stop, not into a fetch', async (t) => {
  const ctx = await mirrorCtx(t)
  const entry = await firstEntry(ctx)
  setRuntimeConfig({ ...getRuntimeConfig(), downloadConcurrency: 1 })
  const overlay = getOverlay()
  const realFetch = overlay.fetchFile
  let fetches = 0
  overlay.fetchFile = async () => { fetches += 1; return null }
  t.teardown(() => { overlay.fetchFile = realFetch })

  const hog = await acquireFetchSlot({})
  t.teardown(() => hog())
  // Settled either way, so a pass that rejects fails the assertions below rather than the process.
  let settled = null
  materializeCatalogFile(ctx.mount, ctx.share, entry).then((value) => { settled = { value } }, (err) => { settled = { err } })
  t.ok(await until(() => fetchSlotStats().queued === 1), 'the pass is parked behind the hogged slot')

  const from = ctx.fake.events.length
  drainFetchSlots(FETCH_OWNER_MIRROR)
  stopForeignLoop(ctx.spaceId, ctx.share.id)
  t.ok(await until(() => settled !== null, 2000), 'the drain released the mirror\'s pass')
  t.is(settled?.err, undefined, 'without a rejection')
  t.is(settled?.value, 'missing', 'and it ended on the stop')
  t.is(fetches, 0, 'and asked no holder')
  // Observed at the re-check itself: a pass that got past it starts the row's transfer, and its
  // cleanup clears that row, even when the fetch fails before reaching a holder.
  const key = shareDecoKey(ctx.share.id, entry.relPath)
  const frames = ctx.fake.events.slice(from).filter((e) => e.type === 'event:decoration' && e.payload?.key === key)
  t.is(frames.length, 0, 'the row never started a transfer')
  t.is(fetchSlotStats().queued, 0, 'nothing is left parked')
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
  async function settleTick() { await until(() => fetchSlotStats().queued === 0) }
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
