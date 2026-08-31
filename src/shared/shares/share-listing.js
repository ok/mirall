// The display listing for one folder share: catalog entries in, renderable rows out. It lives
// here rather than in the worker entrypoint so its read pattern is assertable — the property this
// module holds is "reads do not scale with rows", and that cannot be tested through a closure in
// an entrypoint no test can import.
//
// Data-layer calls arrive as an injected bundle with production defaults for the same reason: a
// test counts calls by passing doubles, production passes nothing.
import fs from 'bare-fs'
import { createLogger } from '../core/logger.js'
import { getListFilesCap } from '../core/runtime-config.js'
import { pathFromMount } from '../transfer/path-guard.js'
import { consumerRowStatusFor, unhashedStatusFor } from '../transfer/transfer-status.js'
import { transferIdFor } from '../transfer/transfer-id.js'
import { listingTruncated } from '../folders/share-limits.js'
import { getOwnedMount, getForeignMount } from '../folders/mount-store.js'
import { listPendingForSpace } from '../transfer/pending-transfers.js'
import { isOwnerOnline } from '../transfer/swarm.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { foreignFetchActive } from '../folders/foreign-folders.js'
import { overlayHasTransfer } from '../transfer/backends/overlay/overlay-backend.js'
import {
  claimedPathFor,
  isDownloadedFile,
  isVerifiedDownload,
  getVerifiedHash,
  getDownloadedPath,
} from '../transfer/files.js'

const log = createLogger('share-listing')

// What production passes for `deps`; a test passes doubles instead.
const productionDeps = {
  getOwnedMount,
  getForeignMount,
  listPendingForSpace,
  isOwnerOnline,
  getLocalPublicKeyHex,
  foreignFetchActive,
  overlayHasTransfer,
  claimedPathFor,
  isDownloadedFile,
  isVerifiedDownload,
  getVerifiedHash,
  getDownloadedPath,
}

function statSizeOrNull(absPath) {
  try { return fs.statSync(absPath).size } catch { return null }
}

// Consumer-side status for a catalog-backed overlay share row. A null contentHash means the owner
// is still hashing → `preparing` while the owner is online, else `unavailable` (entries are
// advertised before hashing completes). Downloads land in the downloads folder and are recorded in
// the downloaded registry (markDownloaded), so `downloaded` is detected via isDownloadedFile — a
// file counts as downloaded iff the registry lists it.
async function overlayConsumerRow(spaceId, share, entry, { ownerOnline, foreignMount, pending, deps }) {
  if (foreignMount && foreignMount.enabled) {
    const abs = pathFromMount(foreignMount.mountPath, entry.relPath)
    if (statSizeOrNull(abs) === entry.size) {
      const verified = !!entry.contentHash && (await deps.getVerifiedHash(spaceId, share.id + '|' + entry.relPath)) === entry.contentHash
      return { status: 'synced', localPath: abs, verified }
    }
    // The mirror loop is pulling this row right now — 'downloading' so FolderView's
    // bar/speed/verify lane (all gated on the status) render during materialization.
    if (deps.foreignFetchActive(spaceId, share.id, entry.relPath)) {
      return { status: 'downloading', localPath: null, pendingBytes: 0 }
    }
    if (!entry.contentHash) return { status: unhashedStatusFor(ownerOnline), localPath: null }
    return { status: ownerOnline ? 'remote' : 'unavailable', localPath: null }
  }
  const drivePath = '/' + share.name + '/' + entry.relPath
  if (await deps.isDownloadedFile(spaceId, drivePath, entry.contentHash)) {
    const verified = await deps.isVerifiedDownload(spaceId, share.id + '|' + entry.relPath, entry.contentHash)
    return { status: 'downloaded', localPath: (await deps.getDownloadedPath(spaceId, drivePath)) || deps.claimedPathFor(drivePath, null), verified }
  }
  // Status is one ordered rule set, mirroring the loose path's order (which hand-rolls the same
  // null-hash-first check at its call site) — an in-flight fetch is 'downloading', a null hash is
  // the owner's index, and only then does the durable pending row decide error/paused. Derived
  // there, never overlaid by the renderer.
  const transferId = transferIdFor(spaceId, share.id, entry.relPath)
  const row = consumerRowStatusFor({
    hashed: Boolean(entry.contentHash),
    isActive: deps.overlayHasTransfer(transferId),
    pendingRow: pending?.get(drivePath),
    ownerOnline,
  })
  return { ...row, localPath: null }
}

export async function listOverlayShareFiles(spaceId, share, backend, deps = productionDeps) {
  const isOwn = share.owner === deps.getLocalPublicKeyHex()
  // One bounded pass returns the first `cap` catalog entries AND the true {total, totalBytes}
  // for the whole share, so a huge folder never materialises a 150k-row array and the count is
  // always consistent with the rows (total >= entries.length). The rich display rows below are
  // built only for the capped entries.
  const cap = getListFilesCap()
  const { entries, total, totalBytes, complete = true } = isOwn
    ? await backend.listOwn(spaceId, share.id, cap)
    : await backend.listPeerWithMeta(spaceId, share, cap)
  const ownerOnline = isOwn ? true : deps.isOwnerOnline(share.owner)
  const ownedMount = isOwn ? await deps.getOwnedMount(spaceId, share.id) : null
  const foreignMount = isOwn ? null : await deps.getForeignMount(spaceId, share.id)
  const pending = isOwn ? null : new Map((await deps.listPendingForSpace(spaceId)).map((p) => [p.filePath, p]))
  const out = []
  for (const entry of entries) {
    let row
    try {
      // pathFromMount throws on an unsafe peer-supplied relPath — skip that one
      // entry rather than aborting the whole listing (a malicious owner catalog
      // must not make the share un-browsable).
      if (isOwn) {
        row = { status: entry.contentHash ? 'synced' : 'publishing', localPath: ownedMount ? pathFromMount(ownedMount.mountPath, entry.relPath) : null }
      } else {
        row = await overlayConsumerRow(spaceId, share, entry, { ownerOnline, foreignMount, pending, deps })
      }
    } catch (err) {
      log.warn('skipping overlay file row with an unsafe path:', entry.relPath, '-', err.message)
      continue
    }
    out.push({ relPath: entry.relPath, size: entry.size, hash: entry.contentHash || '', mtime: entry.mtime, status: row.status, localPath: row.localPath, verified: row.verified || false, pendingBytes: row.pendingBytes, errorCode: row.errorCode, transferId: isOwn ? undefined : transferIdFor(spaceId, share.id, entry.relPath) })
  }
  // Truncation is a FACT the worker reports, never something the renderer infers from
  // (total > rows): on an incomplete read `total` is itself partial, so that inference collapses
  // to false exactly when the rows were capped — and the truncation goes silent.
  const truncated = listingTruncated({ rowCount: entries.length, total, cap, complete })
  if (truncated) log.debug(`share:list-files showing ${out.length} of ${total} rows for share ${share.id} (capped at ${cap})`)
  return { entries: out, complete, total, totalBytes, truncated, fileLimit: truncated ? cap : null }
}
