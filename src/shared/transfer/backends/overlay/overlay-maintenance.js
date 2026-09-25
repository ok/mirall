// Overlay maintenance: the work that keeps the index and the serve maps honest, rather than
// publishing or consuming anything.
//
// Three jobs with one thing in common — all run outside a user action and must not race one.
// Compaction is single-flight because two reclaims racing the same core purge can strand a blob;
// the boot rehydrate and the presence sweep walk every own share, folder and loose alike, and ask
// each share's publish channel for the per-kind facts: its root, whether a row's file is still
// there, how an entry is re-registered and how a vanished one is retired.

import { createLogger } from '../../../core/logger.js'

import { getStore } from '../../../core/store.js'
import { getPublishScheduler, publishChannelFor, settleCatalog } from '../../../folders/publish-service.js'
import { listOwnShare } from '../../../shares/own-catalog.js'
import { readOwnShares } from '../../../shares/shares.js'
import { clearAndPurgeCore, purgeAlias } from '../../../storage/core-purge.js'
import { listSpaces } from '../../../spaces/space.js'
import { compactStore } from '../../../storage/compaction.js'
import { createPresenceSweeper } from '../../../folders/retire-confirm.js'
import { LOOSE_SHARE_ID } from '../../transfer-id.js'
import { getOverlay } from './overlay-instance.js'

const log = createLogger('overlay-maintenance')

// Teardown: the sweeper's per-share consideration state dies with the process that formed it.
export function resetOverlayMaintenance() { presenceSweeper.reset() }

// Reclaim the overlay index: rebuild it without chunk maps for content no longer
// shared or held, then return the freed disk to the OS. Non-destructive — a dropped
// map is content-addressed and re-chunks on the next serve.
// Single-flight so two reclaims can't race the same core purge. A transfer write
// that lands mid-compaction is rebuildable (chunk maps re-chunk, file:/sync:/tree:
// re-derive from the catalog/source), so no user data is at risk.
let compactingIndex = false
export async function compactOverlayIndex() {
  const overlay = getOverlay()
  if (!overlay || compactingIndex) return { compacted: false }
  compactingIndex = true
  try {
    // Authoritative "still served" set = the live owned-catalog hashes. serveIndex is
    // rebuilt from it on boot but accumulates superseded hashes across a session, so it
    // can't be trusted to decide which content-addressed maps are dead.
    const served = new Set()
    const addCatalogHashes = async (spaceId, shareId) => {
      for await (const entry of listOwnShare(spaceId, shareId)) {
        if (entry.contentHash) served.add(entry.contentHash)
      }
    }
    for (const space of await listSpaces()) {
      for (const share of await readOwnShares(space.spaceId)) await addCatalogHashes(space.spaceId, share.id)
      // Loose single-file shares aren't in readOwnShares — they live under the loose
      // pseudo-share. Miss them here and compaction drops the chunk maps of files still
      // being shared, forcing a re-chunk on the next serve.
      await addCatalogHashes(space.spaceId, LOOSE_SHARE_ID)
    }
    const retired = await overlay.compactIndex({ isServed: (hash) => served.has(hash) })
    if (!retired) return { compacted: false } // nothing droppable — index left untouched
    const cs = getStore()
    await clearAndPurgeCore(cs, retired.core)
    await purgeAlias(cs, retired.alias.namespace, retired.alias.name)
    await compactStore()
    return { compacted: true }
  } finally {
    compactingIndex = false
  }
}

// Every own share with content to walk: each folder share of each space, plus the loose
// pseudo-share of each space. A channel whose files live under one root resolves it once per share
// — a large share costs one mount read, not one per row — and a share with no root right now is
// skipped whole. One share's failure never skips the shares after it.
async function forEachOwnContent(cb) {
  for (const { spaceId } of await listSpaces()) {
    let folderIds = []
    try {
      folderIds = (await readOwnShares(spaceId)).filter((s) => s.contentMode === 'overlay').map((s) => s.id)
    } catch (err) {
      log.debug('skip folder shares of space', spaceId, '-', err.message)
    }
    for (const shareId of [...folderIds, LOOSE_SHARE_ID]) {
      const channel = publishChannelFor(shareId)
      try {
        const root = channel.contentRoot ? await channel.contentRoot({ spaceId, shareId }) : null
        if (channel.contentRoot && !root) continue
        await cb({ spaceId, shareId, channel, root })
      } catch (err) {
        log.debug('skip share', spaceId, shareId, '-', err.message)
      }
    }
  }
}

// Boot rehydrate: the serve maps are not persisted, so after a restart every own file is
// re-registered against its source. Entries are walked one at a time with per-file isolation; an
// entry that needs a re-hash hands back its lane settlement, and those are awaited together at
// the end, so no share waits on another share's hashing.
export async function rehydrateOwnedContent() {
  const tails = []
  const skip = (shareId, relPath) => (err) => log.warn('skip file during rehydrate:', shareId, relPath, '-', err.message)
  await forEachOwnContent(async ({ spaceId, shareId, channel, root }) => {
    for await (const entry of listOwnShare(spaceId, shareId)) {
      try {
        const out = await channel.rehydrate({ root, spaceId, shareId, entry })
        if (out?.settled) tails.push(out.settled.catch(skip(shareId, entry.relPath)))
      } catch (err) {
        skip(shareId, entry.relPath)(err)
      }
    }
  })
  await Promise.all(tails)
}

// Proposes on two consecutive misses (an atomic-save window must not transiently unshare a
// still-present file) and never touches an entry whose publish is queued or running. The reclaim
// goes onto the lane through the channel, never written here: the runner re-confirms the file is
// really gone, the write joins the space's catalog batch, and the eviction rides with it.
const presenceSweeper = createPresenceSweeper({
  keyOf: ({ spaceId, shareId }, entry) => spaceId + '\0' + shareId + '\0' + entry.relPath,
  isPending: ({ spaceId, shareId }, entry) => getPublishScheduler().isPending(spaceId, shareId, entry.relPath),
  presentAt: ({ spaceId, channel, root }, entry) => channel.presentAt({ root, spaceId, relPath: entry.relPath }),
  retire: ({ spaceId, shareId, channel, retires }, entry) => {
    retires.push(channel.retireGone({ spaceId, shareId, relPath: entry.relPath })
      .catch((err) => log.debug('retire failed:', shareId, entry.relPath, '-', err.message)))
  },
})

// Backstop: tombstone catalog entries whose source vanished without a watcher unlink. Single
// flight: two overlapping passes would share the sweeper's miss set, and their back-to-back misses
// would count as the two consecutive ones. A bulk retire through the space's catalog batch lands
// only with the flush, so the pass outlasts the flush, not the enqueue.
let sweeping = null
export function sweepOwnedPresence() {
  sweeping ??= sweepOnce().finally(() => { sweeping = null })
  return sweeping
}

async function sweepOnce() {
  const retires = []
  const batched = new Set()
  await forEachOwnContent(async (ctx) => {
    const before = retires.length
    for await (const entry of listOwnShare(ctx.spaceId, ctx.shareId)) await presenceSweeper.consider({ ...ctx, retires }, entry)
    if (retires.length > before && !ctx.channel.direct) batched.add(ctx.spaceId)
  })
  await Promise.all(retires)
  for (const spaceId of batched) await settleCatalog(spaceId)
}
