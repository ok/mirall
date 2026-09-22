// The display listing for one folder share: catalog entries in, renderable rows out. The property
// this module holds is "reads do not scale with rows"; data-layer calls arrive as an injected
// bundle with production defaults so a test can count them with doubles.
import { createLogger } from '../core/logger.js'
import { getListFilesCap } from '../core/runtime-config.js'
import { throwIfAborted } from '../core/cancellation.js'
import { pathFromMount } from '../folders/path-guard.js'
import { consumerRowStatusFor, unhashedStatusFor } from '../transfer/transfer-status.js'
import { transferIdFor } from '../transfer/transfer-id.js'
import { listingTruncated } from '../folders/share-limits.js'
import { getOwnedMount, getForeignMount } from '../folders/mount-store.js'
import { listPendingForSpace } from '../transfer/pending-transfers.js'
import { isOwnerOnline } from '../network/presence-leases.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { foreignFetchActive } from '../folders/mirror-fetch.js'
import { requestMirrorWalk } from '../folders/foreign-verbs.js'
import { localRelOf } from '../folders/mirror-state.js'
import { folderHasTransfer } from '../transfer/backends/overlay/folder-downloads.js'
import {
  claimedPathFor,
  getDownloadedPath,
  verdictForClaim,
  createDirProbe,
  statOrNull,
  listVerifiedRecordsForShare,
  listDownloadClaimsForShare,
  pruneDownloadClaims,
} from '../transfer/files.js'
import { COPY_VERDICT, verifiedCopyVerdict } from '../transfer/verified-copy.js'
import { SHARE_FILE_STATUS } from '../contract/statuses.js'

const log = createLogger('share-listing')

// What production passes for `deps`; a test passes doubles instead.
const productionDeps = {
  getOwnedMount,
  getForeignMount,
  listPendingForSpace,
  isOwnerOnline,
  getLocalPublicKeyHex,
  foreignFetchActive,
  requestMirrorWalk,
  overlayHasTransfer: folderHasTransfer,
  claimedPathFor,
  verdictForClaim,
  listVerifiedRecordsForShare,
  listDownloadClaimsForShare,
  pruneDownloadClaims,
}

// A row that holds local bytes: a verified copy is vouched for, an edited one is 'modified', and a
// copy nothing proves either way keeps `status` unverified.
function onDeviceRow(status, localPath, verdict) {
  if (verdict === COPY_VERDICT.MODIFIED) return { status: SHARE_FILE_STATUS.MODIFIED, localPath, verified: false }
  return { status, localPath, verified: verdict === COPY_VERDICT.VERIFIED }
}

// Consumer-side status for a catalog-backed overlay share row. A null contentHash means the owner
// is still hashing → `preparing` while the owner is online, else `unavailable` (entries are
// advertised before hashing completes). A file counts as downloaded iff the downloaded registry
// still claims it AND the disk agrees — and the claim comes from the listing's prefetched map, so
// no row reads the bee.
//
// Synchronous by design: every fact it needs is in a prefetched map, an in-memory engine map, or a
// stat. The row loop therefore never yields, which is what removes the worker-side stall.
//
// `verified` holds whole records, and a row is judged by the rule the mirror's fast path uses
// (verified-copy.js), so the row never vouches for a file the next pass would re-hash. Each writer
// records `local` in its own form — mount-relative for the mirror, absolute for a download — and a
// row asks for its own, so one writer's record never vouches for the other's file.
function overlayConsumerRow(spaceId, share, entry, { ownerOnline, foreignMount, pending, verified, claims, prune, dirProbe, deps }) {
  const rec = verified.get(entry.relPath)
  const copyVerdict = (stat, expectLocal, rehashed) => verifiedCopyVerdict(rec, stat, { contentHash: entry.contentHash, expectedSize: entry.size, expectLocal, rehashed })

  if (foreignMount && foreignMount.enabled) {
    // Not entry.relPath: a pre-existing user file at the natural name forces the mirror to
    // materialize at a collision-free sibling, and stat'ing the natural name then reports a
    // fully-mirrored file as 'remote'.
    const localRel = localRelOf(foreignMount, entry.relPath)
    const abs = pathFromMount(foreignMount.mountPath, localRel)
    const stat = statOrNull(abs)
    const verdict = copyVerdict(stat, localRel, true)
    // The record decides when it describes this file; without one, a file of the advertised size is
    // taken as the mirror's, unverified. A copy that drifted from its record asks for the walk that
    // re-hashes it.
    if (verdict !== COPY_VERDICT.UNPROVEN || stat?.size === entry.size) {
      const wantsWalk = verdict === COPY_VERDICT.MODIFIED || verdict === COPY_VERDICT.DRIFTED
      return { ...onDeviceRow(SHARE_FILE_STATUS.SYNCED, abs, verdict), mirrored: true, wantsWalk }
    }
    // The mirror loop is pulling this row right now — 'downloading', so FolderView's bar/speed/
    // verify lane render. Gated on reachability, like the strip and the folder tile: a fetch parked
    // on the overlay's peer wait pulls nothing, and a downloading row with no bytes paints as
    // "Preparing…" beside a banner saying the owner is offline.
    if (ownerOnline && deps.foreignFetchActive(spaceId, share.id, entry.relPath)) {
      return { status: 'downloading', localPath: null, pendingBytes: 0, mirrored: true }
    }
    if (!entry.contentHash) return { status: unhashedStatusFor(ownerOnline), localPath: null, mirrored: true }
    return { status: ownerOnline ? 'remote' : 'unavailable', localPath: null, mirrored: true }
  }

  const drivePath = '/' + share.name + '/' + entry.relPath
  const claim = claims.get(drivePath) || null
  const verdict = deps.verdictForClaim(spaceId, drivePath, claim, entry.contentHash, dirProbe)
  // Collected, never acted on here: a del is a write, and taking a write turn per stale row is the
  // cost this batching exists to remove. The listing flushes them once, after the rows.
  if (verdict.prune) prune.push(drivePath)
  if (verdict.downloaded) {
    const localPath = deps.claimedPathFor(drivePath, claim)
    return onDeviceRow(SHARE_FILE_STATUS.DOWNLOADED, localPath, copyVerdict(verdict.stat ?? null, localPath, false))
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

// Two range scans replace up to three point reads PER ROW. Scoped to the rows this listing can
// render, and to the branch it will take: an owner listing reads neither namespace (its rows are
// pure path arithmetic), and a mounted mirror reads only the verified namespace (its rows never
// consult a download claim). Every row then sees ONE consistent snapshot instead of its own
// moment, so a listing can no longer render two of its rows against different states of the world.
async function prefetchRowState(spaceId, share, entries, { isOwn, foreignMount, deps }) {
  if (isOwn) return { verified: new Map(), claims: new Map() }
  const relPaths = new Set(entries.map((entry) => entry.relPath))
  const verified = await deps.listVerifiedRecordsForShare(spaceId, share.id, { keep: relPaths })
  if (foreignMount && foreignMount.enabled) return { verified, claims: new Map() }
  const keep = new Set([...relPaths].map((relPath) => '/' + share.name + '/' + relPath))
  return { verified, claims: await deps.listDownloadClaimsForShare(spaceId, share.name, { keep }) }
}

function ownerRow(entry, ownedMount) {
  return {
    status: entry.contentHash ? 'synced' : 'publishing',
    localPath: ownedMount ? pathFromMount(ownedMount.mountPath, entry.relPath) : null,
  }
}

// An owner listing needs only its mount; a consumer listing needs the owner's presence, its own
// mount and the pending claims, none of which the owner side reads.
async function loadListingContext(spaceId, share, isOwn, deps) {
  if (isOwn) return { ownerOnline: true, ownedMount: await deps.getOwnedMount(spaceId, share.id), foreignMount: null, pending: null }
  return {
    ownerOnline: deps.isOwnerOnline(share.owner),
    ownedMount: null,
    foreignMount: await deps.getForeignMount(spaceId, share.id),
    pending: new Map((await deps.listPendingForSpace(spaceId)).map((p) => [p.filePath, p])),
  }
}

// `signal` is the router's cancellation token. The checkpoints sit at the await boundaries, not in
// the row loop: that loop is synchronous, so `aborted` cannot change mid-pass. The one that pays is
// the catalog read above it, network-bound for a peer share and carrying its own timeout.
export async function listOverlayShareFiles(spaceId, share, backend, deps = productionDeps, { signal = null } = {}) {
  throwIfAborted(signal)
  const isOwn = share.owner === deps.getLocalPublicKeyHex()
  // One bounded pass returns the first `cap` catalog entries AND the true {total, totalBytes}
  // for the whole share, so a huge folder never materialises a 150k-row array and the count is
  // always consistent with the rows (total >= entries.length). The rich display rows below are
  // built only for the capped entries.
  const cap = getListFilesCap()
  const { entries, total, totalBytes, complete = true } = isOwn
    ? await backend.listOwn(spaceId, share.id, cap)
    : await backend.listPeerWithMeta(spaceId, share, cap)
  throwIfAborted(signal)
  const { ownerOnline, ownedMount, foreignMount, pending } = await loadListingContext(spaceId, share, isOwn, deps)
  const { verified, claims } = await prefetchRowState(spaceId, share, entries, { isOwn, foreignMount, deps })
  // The last point an abort can land: everything below is synchronous until the prune.
  throwIfAborted(signal)

  const prune = []
  // One probe for the whole pass: a detached download folder is one question, not one per row. A
  // memo this pass makes for itself, so it stays out of `deps` and every test double.
  const dirProbe = createDirProbe()
  const out = []
  let wantsWalk = false
  for (const entry of entries) {
    let row
    try {
      // pathFromMount throws on an unsafe peer-supplied relPath — skip that one
      // entry rather than aborting the whole listing (a malicious owner catalog
      // must not make the share un-browsable).
      row = isOwn
        ? ownerRow(entry, ownedMount)
        : overlayConsumerRow(spaceId, share, entry, { ownerOnline, foreignMount, pending, verified, claims, prune, dirProbe, deps })
    } catch (err) {
      log.warn('skipping overlay file row with an unsafe path:', entry.relPath, '-', err.message)
      continue
    }
    if (row.wantsWalk) wantsWalk = true
    out.push({ relPath: entry.relPath, size: entry.size, hash: entry.contentHash || '', mtime: entry.mtime, status: row.status, localPath: row.localPath, verified: row.verified || false, mirrored: row.mirrored || false, pendingBytes: row.pendingBytes, errorCode: row.errorCode, transferId: isOwn ? undefined : transferIdFor(spaceId, share.id, entry.relPath) })
  }

  // Awaited so a caller can observe the flush, caught so a failed cache cleanup can never fail the
  // listing the rows are already built for.
  if (prune.length) await deps.pruneDownloadClaims(spaceId, prune).catch((err) => log.debug('claim prune failed:', err.message))
  // The next mirror pass is what settles a mirrored file that drifted from its record — an edit
  // kept as a conflicted copy and the owner's version restored, or unchanged bytes re-fingerprinted
  // — so the listing asks for that pass now rather than leaving it to the full-walk backstop.
  if (wantsWalk) deps.requestMirrorWalk(spaceId, share.id)

  // Truncation is a FACT the worker reports, never something the renderer infers from
  // (total > rows): on an incomplete read `total` is itself partial, so that inference collapses
  // to false exactly when the rows were capped — and the truncation goes silent.
  const truncated = listingTruncated({ rowCount: entries.length, total, cap, complete })
  if (truncated) log.debug(`share:list-files showing ${out.length} of ${total} rows for share ${share.id} (capped at ${cap})`)
  return { entries: out, complete, total, totalBytes, truncated, fileLimit: truncated ? cap : null }
}

// Where a consumer's copy of a share file sits, by the rule its row's localPath follows: an enabled
// mirror's path for it — the collision sibling when the mirror renamed it — else the download claim.
export async function consumerFilePath(spaceId, share, relPath) {
  const foreignMount = await getForeignMount(spaceId, share.id)
  if (foreignMount && foreignMount.enabled) return pathFromMount(foreignMount.mountPath, localRelOf(foreignMount, relPath))
  const drivePath = '/' + share.name + '/' + relPath
  return (await getDownloadedPath(spaceId, drivePath)) || claimedPathFor(drivePath, null)
}
