import test from 'brittle'
import b4a from 'b4a'
import Hyperbee from 'hyperbee'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { scaled } from '../helpers/bare-timing.js'
import { mutateMembers } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import { generateShareId } from '../../src/shared/shares/shares.js'
import { listSharesForSpace } from '../../src/shared/shares/share-registry.js'
import { fileKey } from '../../src/shared/shares/catalog-keys.js'
import { getStore } from '../../src/shared/core/store.js'
import { createCancellation } from '../../src/shared/core/cancellation.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/overlay/index.js'
import { takeIncompleteListSpaces } from '../../src/shared/transfer/list-deficits.js'
import { listOverlayShareFiles } from '../../src/shared/shares/share-listing.js'
import { createForeignMount } from '../../src/shared/folders/mount-store.js'
import { initialMaterializeScan } from '../../src/shared/folders/mirror-pass.js'
import { initOverlayIpc } from '../helpers/overlay-ipc.js'

// A folder listing whose peer read stalled or threw flags the space for the convergence tick. The
// case that needs it: the owner's catalog head has synced, so its `append` has already fired, but
// the drain timed out on blocks not yet here. Those blocks arriving later fire no append, so
// nothing else re-pokes the listing and it stays partial. The mirror pass reads the backend
// directly and never flags.

// absolute: the budget is passed INTO the read under test; the assertion is that it gives up.
const READ_BUDGET_MS = 50

async function setup(t) {
  const ctx = await freshPeer(t)
  await initOverlay()
  initOverlayIpc(ctx.fake.ipc)
  t.teardown(async () => { await teardownOverlay() })
  await initDownloads()
  await initPendingTransfers()
  const saved = getRuntimeConfig()
  setRuntimeConfig({ ...saved, peerReadTimeoutMs: READ_BUDGET_MS })
  t.teardown(() => setRuntimeConfig(saved))
  // The drain timer is unref'd, so a read parked on a missing block leaves Bare an empty
  // loop; the worker always holds its loop open, and so does this test.
  const holdLoop = setInterval(() => {}, 1000)
  t.teardown(() => clearInterval(holdLoop))
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId }
}

// A remote owner whose catalog head is known here but whose blocks are not: the catalog lives in
// a second store that replicates just long enough for the head to sync, then disconnects. A read
// then finds the length but cannot fetch a block — a real stalled read, not a stub.
// `releaseBlocks` reconnects the holder; the length is unchanged, so no append fires.
async function seedHeadOnlyShare(t, spaceId, entries) {
  const owner = await makePeer(t)
  const holder = await makePeer(t)
  const shareId = generateShareId()
  const catalogCore = holder.store.get({ name: 'catalog' })
  await catalogCore.ready()
  const catalog = new Hyperbee(catalogCore, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  for (const e of entries) await catalog.put(fileKey(shareId, e.relPath), { size: e.size, mtime: 0, contentHash: e.contentHash })
  await owner.bee.put('caps/folder-shares', true)
  await owner.bee.put('share/' + spaceId + '/' + shareId, {
    id: shareId, type: 'owned-folder', name: 'Remote', createdAt: 1,
    contentMode: 'overlay', catalogKey: b4a.toString(catalogCore.key, 'hex'),
  })
  replicate(owner.store, getStore(), t)
  await mutateMembers(spaceId, () => [{ publicKey: owner.key, driveKey: null, displayName: 'Owner' }])
  t.ok(await waitFor(async () => (await listSharesForSpace(spaceId)).some((s) => s.id === shareId), scaled(5000)), 'the share record replicated')
  const share = (await listSharesForSpace(spaceId)).find((s) => s.id === shareId)

  const local = getStore().get({ key: catalogCore.key })
  await local.ready()
  t.teardown(async () => { try { await local.close() } catch {} })
  const link = replicate(holder.store, getStore(), t)
  await local.update({ wait: true })
  link.destroy()
  t.is(local.length, catalogCore.length, 'the head synced')
  t.absent(await local.has(0, local.length), 'and the blocks did not')
  const append = (e) => catalog.put(fileKey(shareId, e.relPath), { size: e.size, mtime: 0, contentHash: e.contentHash })
  return { share, ownerKey: owner.key, releaseBlocks: () => replicate(holder.store, getStore(), t), append }
}

// Records what each catalog read returned, so a case can prove its read really stalled.
function observeReads(t) {
  const reads = []
  const inner = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async (...args) => {
    const res = await inner(...args)
    reads.push(res)
    return res
  }
  t.teardown(() => { overlayBackend.listPeerWithMeta = inner }, { order: -1 })
  return reads
}

const filesUpdated = (ctx) => ctx.fake.events.filter((e) => e.type === 'event:files-updated' && e.payload?.spaceId === ctx.spaceId).length

test('REGRESSION (FIX-4A: a folder listing whose drain stalled after its head synced was never re-poked)', { timeout: scaled(30000) }, async (t) => {
  const ctx = await setup(t)
  const { share, releaseBlocks, append } = await seedHeadOnlyShare(t, ctx.spaceId, [
    { relPath: 'a.bin', size: 4, contentHash: 'ha' },
    { relPath: 'b.bin', size: 4, contentHash: 'hb' },
  ])
  const reads = observeReads(t)
  takeIncompleteListSpaces()

  const partial = await listOverlayShareFiles(ctx.spaceId, share, overlayBackend)
  t.is(reads.at(-1)?.stalled, true, 'the read of the head-only catalog really stalled')
  t.is(partial.complete, false, 'and the listing reports itself incomplete')
  t.alike(takeIncompleteListSpaces(), [ctx.spaceId], 'the stalled read flags the space for the tick to re-poke')

  const framesBefore = filesUpdated(ctx)
  releaseBlocks()
  let healed = null
  t.ok(await waitFor(async () => {
    healed = await listOverlayShareFiles(ctx.spaceId, share, overlayBackend)
    return reads.at(-1)?.stalled === false
  }, scaled(10000)), 'with the blocks reachable, a re-read finishes')
  t.is(healed.complete, true, 'and the listing is complete')
  t.is(healed.entries.length, 2, 'with every row')
  t.is(filesUpdated(ctx), framesBefore, 'the blocks arriving fired no files-updated: only the tick re-pokes this listing')
  takeIncompleteListSpaces()
  await listOverlayShareFiles(ctx.spaceId, share, overlayBackend)
  t.is(reads.at(-1)?.stalled, false, 'the next read finishes too')
  t.alike(takeIncompleteListSpaces(), [], 'a finished read flags nothing, so the tick stops re-poking')

  // Positive control for the frame count above: an owner append on the same catalog does reach
  // the folder watch, so the count could not have held for want of wiring.
  await append({ relPath: 'c.bin', size: 4, contentHash: 'hc' })
  t.ok(await waitFor(() => filesUpdated(ctx) > framesBefore, scaled(5000)), 'an owner append on the same catalog does fire files-updated')
})

test("the mirror pass's stalled read of the same catalog never flags the space", { timeout: scaled(30000) }, async (t) => {
  const ctx = await setup(t)
  const { share, ownerKey } = await seedHeadOnlyShare(t, ctx.spaceId, [{ relPath: 'a.bin', size: 4, contentHash: 'ha' }])
  const mount = {
    spaceId: ctx.spaceId, shareId: share.id, ownerKey, mountPath: ctx.tmpDir('mirror'),
    enabled: true, attachedAt: Date.now(), status: 'scanning', syncedPaths: [], renamedPaths: {},
  }
  await createForeignMount(mount)
  const reads = observeReads(t)
  takeIncompleteListSpaces()

  await initialMaterializeScan(mount)
  t.is(reads.length, 1, 'the mirror pass read the catalog')
  t.is(reads[0].stalled, true, 'and that read stalled')
  t.alike(takeIncompleteListSpaces(), [], 'the mirror pass flags nothing: it would re-poke the listing on every pass')
})

// Wiring only: a thrown catalog read is not cheaply reproducible against a real store, so the
// backend throws. The listing still fails; the space is flagged so the tick retries it.
test('a peer read that throws flags the space', { timeout: scaled(30000) }, async (t) => {
  const ctx = await setup(t)
  const { share } = await seedHeadOnlyShare(t, ctx.spaceId, [{ relPath: 'a.bin', size: 4, contentHash: 'ha' }])
  takeIncompleteListSpaces()
  const backend = { listPeerWithMeta: async () => { throw new Error('catalog read failed') } }
  await t.exception(listOverlayShareFiles(ctx.spaceId, share, backend), /catalog read failed/)
  t.alike(takeIncompleteListSpaces(), [ctx.spaceId], 'the failed read flags the space')
})

test('a cancelled listing does not flag the space, even when its read stalled', { timeout: scaled(30000) }, async (t) => {
  const ctx = await setup(t)
  const { share } = await seedHeadOnlyShare(t, ctx.spaceId, [{ relPath: 'a.bin', size: 4, contentHash: 'ha' }])
  const cancellation = createCancellation()
  const reads = []
  const backend = {
    listPeerWithMeta: async (...args) => {
      const res = await overlayBackend.listPeerWithMeta(...args)
      reads.push(res)
      cancellation.abort()
      return res
    },
  }
  takeIncompleteListSpaces()
  await t.exception(listOverlayShareFiles(ctx.spaceId, share, backend, undefined, { signal: cancellation.signal }), /cancelled/)
  t.is(reads[0]?.stalled, true, 'the read stalled')
  t.alike(takeIncompleteListSpaces(), [], 'the superseded listing flags nothing')
})
