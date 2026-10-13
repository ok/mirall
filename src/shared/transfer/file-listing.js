// What a space's files look like to the renderer, and the two verbs that change that set.
//
// A loose file has no single source of truth: the owner's catalog says it exists, the claim bee
// says whether we have it, the pending row says whether it is moving, and the disk decides whether
// "on your device" is still true. The listing is where those are folded into one row per file.

import {
  claimedPathFor,
  createDirProbe,
  forgetFileRecords,
  listLooseDownloadClaims,
  listOwnedSources,
  listVerifiedRecordsForShare,
  pruneDownloadClaims,
  verdictForClaim,
} from './files.js'
import { verifiedCopyVerdict } from './verified-copy.js'
import { FILE_STATUS } from '../contract/statuses.js'
import { createLogger } from '../core/logger.js'

import { CODES } from '../contract/errors.js'
import { AppError } from '../core/errors.js'
import { getListFullReadEvery } from '../core/runtime-config.js'
import { isEphemeralSourcePath } from './temp-paths.js'
import { readCatalogKey } from '../shares/catalog-keys.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getSpace } from '../spaces/space.js'
import { isParticipating } from '../spaces/participation.js'
import { peerMembersOf, readEachPeer } from '../spaces/member-fanout.js'
/** @import { StoredSpace } from '../spaces/space.js' */
/** @import { FileEntry, LooseFileListing } from '../contract/responses.js' */
import { dedupeFileRows } from './file-dedupe.js'
import { emptyListing, looseListing } from './listing-envelope.js'
import { markListIncomplete } from './list-deficits.js'
import { beginListingRead, retainListingMemo, settleListingRead, takeListingMemo } from './listing-memo.js'
import { looseHasOwn, looseListOwn, looseQueuedPaths, looseShareFile, looseUnshareFile } from './overlay/loose-publish.js'
import { hasShareDownload, listPeerWithMeta, watchedCatalogVersion } from './overlay/share-downloads.js'
import { looseShareFor } from './overlay/download-job.js'
import { listPendingForSpace } from './pending-transfers.js'
import { isOwnerOnline } from '../network/presence-leases.js'
import { LOOSE_SHARE_ID, looseDrivePath, looseTransferIdFor } from './transfer-id.js'
import { consumerRowStatusFor } from './transfer-status.js'
import fs from 'bare-fs'
import path from 'bare-path'

const log = createLogger('file-listing')

// A dropped item must resolve to a real, persistent file before we publish it.
// Rejects in-memory-only drops (empty path), macOS promised-file temp locations
// (unsaved screenshots / Photo Booth captures), and anything that isn't a
// readable file on disk. Without this, addFile would happily stream an ephemeral
// source that vanishes moments later, leaving the share pointing at nothing.
async function assertSharableSource(filePath) {
  if (!filePath || isEphemeralSourcePath(filePath)) {
    throw new AppError(CODES.SOURCE_NOT_ON_DISK, 'File is not saved on disk')
  }
  let stat
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    throw new AppError(CODES.SOURCE_NOT_ON_DISK, 'File is not saved on disk')
  }
  if (!stat.isFile()) {
    throw new AppError(CODES.SOURCE_NOT_ON_DISK, 'File is not saved on disk')
  }
}

export async function addFile(spaceId, filePath, fileName) {
  if (!isParticipating(await getSpace(spaceId))) throw new AppError(CODES.DRIVE_NOT_FOUND, 'Space not joined yet')

  await assertSharableSource(filePath)

  return await looseShareFile(spaceId, filePath, fileName || path.basename(filePath))
}

const NO_CLAIM = Object.freeze({ downloaded: false, prune: false })

// What production passes for `deps`; a test passes doubles and counts them.
const productionDeps = {
  listPeer: listPeerWithMeta,
  listPendingForSpace,
  isOwnerOnline,
  hasTransfer: hasShareDownload,
  verdictForClaim,
  listVerifiedRecordsForShare,
  listLooseDownloadClaims,
  listOwnedSources,
  pruneDownloadClaims,
  catalogVersion: watchedCatalogVersion,
}

// Hashed → 'synced' (its bytes are the source on this disk); unhashed → 'queued' while it waits for a
// publish slot, then 'publishing' (server-truth) so it survives a navigate-away/remount, not just the
// optimistic client row. Served in place: the bytes are wherever the user keeps the file.
/** @returns {FileEntry} */
function ownRow(e, localPublicKey, queued, sources) {
  const drivePath = looseDrivePath(e.relPath)
  const status = e.contentHash ? FILE_STATUS.SYNCED : queued.has(e.relPath) ? FILE_STATUS.QUEUED : FILE_STATUS.PUBLISHING
  return {
    path: drivePath, size: e.size, hash: e.contentHash || '', mtime: e.mtime, status,
    localPath: sources.get(drivePath) ?? null,
    owner: { displayName: 'You', publicKey: localPublicKey },
  }
}

// One peer-held row. Synchronous: every fact is a prefetched map, an in-memory engine read or a
// stat, so the loop over every row never yields. A stale claim is collected, never deleted here.
// A claim and a live slot are keyed by name alone and only the content hash ties either to this
// owner's file, so an unhashed entry reads neither; a pending row names its owner, so it counts only
// for that owner's row.
/** @returns {FileEntry} */
function peerRow(spaceId, member, e, ctx) {
  const drivePath = looseDrivePath(e.relPath)
  const hashed = Boolean(e.contentHash)
  const claim = ctx.claims.get(drivePath) || null
  const verdict = hashed ? ctx.deps.verdictForClaim(spaceId, drivePath, claim, e.contentHash, ctx.dirProbe) : NO_CLAIM
  if (verdict.prune) ctx.stale.set(drivePath, verdict.reason)
  if (verdict.downloaded) ctx.held.add(drivePath)
  const localPath = verdict.downloaded ? claimedPathFor(drivePath, claim) : null
  const copyVerdict = verdict.downloaded
    ? verifiedCopyVerdict(ctx.verified.get(e.relPath) || null, verdict.stat ?? null, {
      contentHash: e.contentHash, expectedSize: e.size, expectLocal: localPath,
    })
    : null
  const pendingRow = ctx.pending.get(drivePath)
  const transferId = looseTransferIdFor(spaceId, e.relPath)
  const row = consumerRowStatusFor({
    copyVerdict,
    onDeviceStatus: FILE_STATUS.DOWNLOADED,
    hashed,
    isActive: hashed && ctx.deps.hasTransfer(transferId),
    pendingRow: pendingRow?.ownerKey === member.publicKey ? pendingRow : undefined,
    ownerOnline: ctx.ownerOnline,
  })
  return {
    path: drivePath, size: e.size, hash: e.contentHash || '', mtime: e.mtime, status: row.status, localPath,
    owner: { displayName: member.displayName, publicKey: member.publicKey },
    verified: row.verified || false, pendingBytes: row.pendingBytes, errorCode: row.errorCode, transferId,
  }
}

// One range scan per namespace whatever the row count, so every row sees one consistent snapshot of
// the claims and verified records. A verified record only vouches for a copy, so a scan that fails
// costs the badge, never the listing.
async function prefetchLooseRowState(spaceId, peerEntries, deps) {
  const relPaths = new Set(peerEntries.flat().map((e) => e.relPath))
  if (relPaths.size === 0) return { verified: new Map(), claims: new Map() }
  const keep = new Set([...relPaths].map((relPath) => '/' + relPath))
  const [verified, claims] = await Promise.all([
    deps.listVerifiedRecordsForShare(spaceId, LOOSE_SHARE_ID, { keep: relPaths }).catch((err) => {
      log.warn('verified records unreadable, listing unverified:', err.message)
      return new Map()
    }),
    deps.listLooseDownloadClaims(spaceId, { keep }),
  ])
  return { verified, claims }
}

// One member's catalog, under the fan-out's budget, and whether the read stalled. A member whose read
// fails contributes no rows instead of failing the listing, and counts as stalled. A catalog whose
// version has not moved since its last complete read is served from the listing memo instead.
async function readPeerEntries(spaceId, member, { budget, space, deps }) {
  const share = looseShareFor(member)
  const { keyHex } = readCatalogKey(share)
  let prior = null
  try {
    const version = await deps.catalogVersion(spaceId, share, { space })
    const memo = takeListingMemo(spaceId, keyHex, version, { fullReadEvery: getListFullReadEvery() })
    if (memo.entries) return { entries: memo.entries, stalled: false }
    log.debug('loose catalog read for', keyHex.slice(0, 16) + '...', '-', memo.reason)
    prior = beginListingRead(spaceId, keyHex, memo.reason)
    const read = await deps.listPeer(spaceId, share, { timeoutMs: budget, space })
    // A stalled read (head-sync failed or the traversal timed out) self-heals on the owner's next
    // append unless the stream stays stalled; the deficit makes the convergence tick re-poke the
    // listing. A legitimately empty catalog is not stalled, so it is not re-poked forever.
    if (read.stalled) markListIncomplete(spaceId)
    return { entries: settleListingRead(spaceId, keyHex, read, prior), stalled: Boolean(read.stalled) }
  } catch (err) {
    // Flag the space the way a stalled read does: without this the convergence tick has no
    // reason to re-poke, so a member whose read threw would stay missing from the listing
    // until some unrelated listing poke arrived.
    markListIncomplete(spaceId)
    log.warn('loose catalog read failed for', member.publicKey.slice(0, 16) + '...', '-', err.message)
    return { entries: settleListingRead(spaceId, keyHex, null, prior), stalled: true }
  }
}

// In-place loose files (own + each peer's) read from the loose catalog, one candidate row per
// owner, so dedupeFileRows can merge them, and whether those rows are the whole set.
async function collectLooseInPlace(spaceId, members, { localPublicKey, space, deps }) {
  const queued = looseQueuedPaths(spaceId)
  const [own, sources] = await Promise.all([looseListOwn(spaceId), deps.listOwnedSources(spaceId)])
  const out = own.map((e) => ownRow(e, localPublicKey, queued, sources))
  const peerMembers = peerMembersOf(members, localPublicKey, (m) => Boolean(readCatalogKey(m).keyHex))
  retainListingMemo(spaceId, new Set(peerMembers.map((m) => readCatalogKey(m).keyHex)))
  if (peerMembers.length === 0) return { rows: out, complete: true }
  const pending = new Map((await deps.listPendingForSpace(spaceId)).map((p) => [p.filePath, p]))
  const reads = await readEachPeer(peerMembers, (member, budget) => readPeerEntries(spaceId, member, { budget, space, deps }))
  const peerEntries = reads.map((read) => read.entries)
  const online = peerMembers.map((member) => deps.isOwnerOnline(member.publicKey))
  const { verified, claims } = await prefetchLooseRowState(spaceId, peerEntries, deps)

  const stale = new Map() // drivePath -> the verdict's reason
  const held = new Set()
  const dirProbe = createDirProbe()
  // Member order is the dedupe tie-break, so the fold must see candidates in this order.
  for (const [i, member] of peerMembers.entries()) {
    const ctx = { deps, verified, claims, pending, stale, held, dirProbe, ownerOnline: online[i] }
    for (const e of peerEntries[i]) out.push(peerRow(spaceId, member, e, ctx))
  }
  // A claim is keyed by name, not by owner: one member's replaced file must not prune the claim
  // another member's row in this same listing reads as downloaded.
  const prune = [...stale.keys()].filter((drivePath) => !held.has(drivePath))
  for (const drivePath of prune) log.info('reset on-device claim (' + stale.get(drivePath) + '):', drivePath)
  // Awaited so a caller can observe the flush, caught so a failed cache cleanup never fails the
  // listing the rows are already built for.
  if (prune.length) await deps.pruneDownloadClaims(spaceId, prune).catch((err) => log.debug('claim prune failed:', err.message))
  // An offline member's read always stalls and its rows already say so, so only a member who is
  // online holds the list open.
  return { rows: out, complete: reads.every((read, i) => !read.stalled || !online[i]) }
}

// `space` is the caller's already-read record, so a listing costs one spaces-bee read, not two.
/**
 * @param {string} spaceId @param {object[]} members
 * @param {{ space?: StoredSpace | null, deps?: typeof productionDeps }} [opts]
 * @returns {Promise<LooseFileListing>}
 */
export async function listFiles(spaceId, members, { space = null, deps = productionDeps } = {}) {
  const spaceRecord = space || await getSpace(spaceId)
  if (!isParticipating(spaceRecord)) return emptyListing()

  const { rows, complete } = await collectLooseInPlace(spaceId, members, { localPublicKey: getLocalPublicKeyHex(), space: spaceRecord, deps })
  const listing = looseListing(dedupeFileRows(rows), complete)
  log.debug('listed', listing.total, 'files in space', spaceId, '(' + members?.length, 'members, complete:', complete + ')')
  return listing
}

export async function removeFile(spaceId, filePath) {
  if (await looseHasOwn(spaceId, filePath)) {
    await looseUnshareFile(spaceId, filePath)
    return
  }
  // Not a loose file we own — clear any download-history claim for it.
  await forgetFileRecords(spaceId, filePath)
  log.info('file removed:', filePath, 'from space', spaceId)
}
