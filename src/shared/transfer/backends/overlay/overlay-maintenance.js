// Overlay maintenance: the work that keeps the index and the serve maps honest, rather than
// publishing or consuming anything.
//
// Two jobs with one thing in common — both run outside a user action and must not race one.
// Compaction is single-flight because two reclaims racing the same core purge can strand a blob;
// the boot rehydrate exists because the serve maps are not persisted, so after a restart owned
// files stop being servable until they are re-registered.

import { createLogger } from '../../../core/logger.js'

import { getStore } from '../../../core/store.js'
import { fileExactlyPresent } from '../../../folders/disk-presence.js'
import { getOwnedMount } from '../../../folders/mount-store.js'
import { listOwnShare } from '../../../shares/own-catalog.js'
import { readOwnShares } from '../../../shares/shares.js'
import { clearAndPurgeCore } from '../../../storage/core-purge.js'
import { listSpaces } from '../../../spaces/space.js'
import { compactStore } from '../../../storage/compaction.js'
import { pathFromMount } from '../../../folders/path-guard.js'
import { createPresenceSweeper } from '../../../folders/retire-confirm.js'
import { LOOSE_SHARE_ID } from '../../transfer-id.js'
import { getOverlay } from './overlay-instance.js'
import fs from 'bare-fs'

const log = createLogger('overlay-maintenance')

// makeServable and the publish lane belong to the publish side; maintenance re-registers what
// publish advertised and settles the lane it owns, so both are injected rather than imported —
// the edge runs publish → maintenance, never back.
let makeServable = async () => {}
let publishLane = null

// Teardown: the sweeper's per-share consideration state dies with the process that formed it.
export function resetOverlayMaintenance() { folderSweeper.reset() }

export function initOverlayMaintenance(d) {
  makeServable = d.makeServable
  publishLane = d.publishLane
}

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
    const oldCore = await overlay.compactIndex({ isServed: (hash) => served.has(hash) })
    if (!oldCore) return { compacted: false } // nothing droppable — index left untouched
    const cs = getStore()
    await clearAndPurgeCore(cs, oldCore)
    await compactStore()
    return { compacted: true }
  } finally {
    compactingIndex = false
  }
}

// Boot rehydrate: the facade serve maps (_contentHashPaths) are NOT persisted,
// so after a worker restart owned files stop being servable until re-registered.
// Re-register every owned overlay file whose source still exists.
async function rehydrateShare(spaceId, shareId, mountPath) {
  for await (const entry of listOwnShare(spaceId, shareId)) {
    if (!entry.contentHash) continue
    try {
      const abs = pathFromMount(mountPath, entry.relPath)
      if (!fs.statSync(abs).isFile()) continue
      await makeServable(spaceId, shareId, entry.relPath, abs, entry.contentHash, entry.size)
    } catch (err) {
      log.debug('rehydrate skipped:', entry.relPath, '-', err.message)
    }
  }
}

// Walk every owned overlay share that has a mount, invoking cb(spaceId, shareId,
// mountPath). Shared by rehydrate (boot) and the presence sweep (backstop).
async function forEachOwnedOverlayShare(cb) {
  for (const space of await listSpaces()) {
    let shares
    try { shares = await readOwnShares(space.spaceId) } catch { continue }
    for (const share of shares) {
      if (share.contentMode !== 'overlay') continue
      const mount = await getOwnedMount(space.spaceId, share.id)
      if (mount?.mountPath) await cb(space.spaceId, share.id, mount.mountPath)
    }
  }
}

export async function rehydrateOwnedFiles() {
  await forEachOwnedOverlayShare(rehydrateShare)
}

const folderSweeper = createPresenceSweeper({
  keyOf: ({ spaceId, shareId }, entry) => spaceId + '\0' + shareId + '\0' + entry.relPath,
  isPending: ({ spaceId, shareId }, entry) => !!publishLane?.isPending(spaceId, shareId, entry.relPath),
  // Exact-name presence, like the retire executor: a following stat would keep a case-only
  // rename's old key alive forever on a case-folding volume.
  presentAt: ({ mountPath }, entry) => {
    try { return fileExactlyPresent(pathFromMount(mountPath, entry.relPath)) } catch { return false }
  },
  // Onto the shared publish lane, exactly as the loose sweep retires: the runner re-confirms the
  // file is really gone, the write joins the space's catalog batch, and the eviction rides with it.
  retire: ({ spaceId, shareId, retires }, entry) => {
    const settled = publishLane?.enqueueRetire(spaceId, shareId, entry.relPath)
    // The lane's ticket RESOLVES with a settlement and never rejects — work-item.js's deferred has
    // no reject path — so this has to read the outcome; a .catch here could never fire. (The loose
    // twin may catch because settledWithTail rethrows for it. A cancel is the user stopping it, not
    // a failure.)
    if (settled) {
      retires.push(settled.then((s) => {
        if (s?.outcome === 'failed') log.debug('folder retire failed:', entry.relPath, '-', s.error?.message || 'the publish runner refused it')
      }))
    }
  },
})

// Backstop: tombstone catalog entries whose source file vanished but whose
// chokidar unlink event was missed. Mount-root guarded — a temporarily-
// unavailable mount must never mass-tombstone a share.
export async function overlaySweepPresence() {
  await forEachOwnedOverlayShare(async (spaceId, shareId, mountPath) => {
    try { if (!fs.statSync(mountPath).isDirectory()) return } catch { return } // root gone → skip
    const retires = []
    for await (const entry of listOwnShare(spaceId, shareId)) {
      await folderSweeper.consider({ spaceId, shareId, mountPath, retires }, entry)
    }
    if (!retires.length) return
    await Promise.all(retires)
    await publishLane?.settle(spaceId)
  })
}
