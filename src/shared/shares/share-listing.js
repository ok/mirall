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
import { throwIfAborted } from '../core/cancellation.js'
import { pathFromMount } from '../transfer/path-guard.js'
import { consumerRowStatusFor, unhashedStatusFor } from '../transfer/transfer-status.js'
import { transferIdFor } from '../transfer/transfer-id.js'
import { listingTruncated } from '../folders/share-limits.js'
import { getOwnedMount, getForeignMount } from '../folders/mount-store.js'
import { listPendingForSpace } from '../transfer/pending-transfers.js'
import { isOwnerOnline } from '../transfer/swarm.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { foreignFetchActive } from '../folders/foreign-folders.js'
import { localRelOf } from '../folders/mirror-state.js'
import { overlayHasTransfer } from '../transfer/backends/overlay/overlay-backend.js'
import {
  claimedPathFor,
  verdictForClaim,
  createDirProbe,
  listVerifiedForShare,
  listDownloadClaimsForShare,
  pruneDownloadClaims,
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
  verdictForClaim,
  listVerifiedForShare,
  listDownloadClaimsForShare,
  pruneDownloadClaims,
}

function statSizeOrNull(absPath) {
  try { return fs.statSync(absPath).size } catch { return null }
}

// Consumer-side status for a catalog-backed overlay share row. A null contentHash means the owner
// is still hashing → `preparing` while the owner is online, else `unavailable` (entries are
// advertised before hashing completes). A file counts as downloaded iff the downloaded registry
// still claims it AND the disk agrees — and the claim comes from the listing's prefetched map, so
// no row reads the bee.
//
// Synchronous by design: every fact it needs is in a prefetched map, an in-memory engine map, or a
// stat. The row loop therefore never yields, which is what removes the worker-side stall.
function overlayConsumerRow(spaceId, share, entry, { ownerOnline, foreignMount, pending, verified, claims, prune, dirProbe, deps }) {
  const isVerified = Boolean(entry.contentHash) && verified.get(entry.relPath) === entry.contentHash

  if (foreignMount && foreignMount.enabled) {
    // Not entry.relPath: a pre-existing user file at the natural name forces the mirror to
    // materialize at a collision-free sibling, and stat'ing the natural name then reports a
    // fully-mirrored file as 'remote'.
    const abs = pathFromMount(foreignMount.mountPath, localRelOf(foreignMount, entry.relPath))
    if (statSizeOrNull(abs) === entry.size) return { status: 'synced', localPath: abs, verified: isVerified }
    // The mirror loop is pulling this row right now — 'downloading' so FolderView's
    // bar/speed/verify lane (all gated on the status) render during materialization.
    if (deps.foreignFetchActive(spaceId, share.id, entry.relPath)) {
      return { status: 'downloading', localPath: null, pendingBytes: 0 }
    }
    if (!entry.contentHash) return { status: unhashedStatusFor(ownerOnline), localPath: null }
    return { status: ownerOnline ? 'remote' : 'unavailable', localPath: null }
  }

  const drivePath = '/' + share.name + '/' + entry.relPath
  const rec = claims.get(drivePath) || null
  const verdict = deps.verdictForClaim(spaceId, drivePath, rec, entry.contentHash, dirProbe)
  // Collected, never acted on here: a del is a write, and taking a write turn per stale row is the
  // cost this batching exists to remove. The listing flushes them once, after the rows.
  if (verdict.prune) prune.push(drivePath)
  if (verdict.downloaded) {
    return { status: 'downloaded', localPath: deps.claimedPathFor(drivePath, rec), verified: isVerified }
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
  const verified = await deps.listVerifiedForShare(spaceId, share.id, { keep: relPaths })
  if (foreignMount && foreignMount.enabled) return { verified, claims: new Map() }
  const keep = new Set([...relPaths].map((relPath) => '/' + share.name + '/' + relPath))
  return { verified, claims: await deps.listDownloadClaimsForShare(spaceId, share.name, { keep }) }
}

// `signal` is the router's cancellation token. The checkpoints sit at the await boundaries and
// NOT inside the row loop: that loop is synchronous, so the event loop never turns during it and
// `aborted` cannot change mid-pass — a per-row check would be dead code that reads like diligence.
// The one that pays is the catalog read above it, which for a peer share is network-bound and
// carries its own timeout.
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
  const ownerOnline = isOwn ? true : deps.isOwnerOnline(share.owner)
  const ownedMount = isOwn ? await deps.getOwnedMount(spaceId, share.id) : null
  const foreignMount = isOwn ? null : await deps.getForeignMount(spaceId, share.id)
  const pending = isOwn ? null : new Map((await deps.listPendingForSpace(spaceId)).map((p) => [p.filePath, p]))

  const { verified, claims } = await prefetchRowState(spaceId, share, entries, { isOwn, foreignMount, deps })
  // The last point an abort can land: everything below is synchronous until the prune.
  throwIfAborted(signal)

  const prune = []
  // One probe for the whole pass: a detached download folder is one question, not one per row.
  // Built here rather than injected — it is a memo this pass makes for itself, not a collaborator
  // a caller could meaningfully substitute, so it stays out of `deps` where every test double
  // would otherwise have to know about it.
  const dirProbe = createDirProbe()
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
        row = overlayConsumerRow(spaceId, share, entry, { ownerOnline, foreignMount, pending, verified, claims, prune, dirProbe, deps })
      }
    } catch (err) {
      log.warn('skipping overlay file row with an unsafe path:', entry.relPath, '-', err.message)
      continue
    }
    out.push({ relPath: entry.relPath, size: entry.size, hash: entry.contentHash || '', mtime: entry.mtime, status: row.status, localPath: row.localPath, verified: row.verified || false, pendingBytes: row.pendingBytes, errorCode: row.errorCode, transferId: isOwn ? undefined : transferIdFor(spaceId, share.id, entry.relPath) })
  }

  // Awaited so a caller can observe the flush, caught so a failed cache cleanup can never fail the
  // listing the rows are already built for.
  if (prune.length) await deps.pruneDownloadClaims(spaceId, prune).catch((err) => log.debug('claim prune failed:', err.message))

  // Truncation is a FACT the worker reports, never something the renderer infers from
  // (total > rows): on an incomplete read `total` is itself partial, so that inference collapses
  // to false exactly when the rows were capped — and the truncation goes silent.
  const truncated = listingTruncated({ rowCount: entries.length, total, cap, complete })
  if (truncated) log.debug(`share:list-files showing ${out.length} of ${total} rows for share ${share.id} (capped at ${cap})`)
  return { entries: out, complete, total, totalBytes, truncated, fileLimit: truncated ? cap : null }
}
