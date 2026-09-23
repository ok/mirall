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
  listVerifiedRecordsForShare,
  pruneDownloadClaims,
  verdictForClaim,
} from './files.js'
import { COPY_VERDICT, verifiedCopyVerdict } from './verified-copy.js'
import { FILE_STATUS } from '../contract/statuses.js'
import { createLogger } from '../core/logger.js'

import { CODES } from '../contract/errors.js'
import { AppError } from '../core/errors.js'
import { getListFullReadEvery, isInPlaceFilesEnabled } from '../core/runtime-config.js'
import { interactiveReadTimeoutMs } from '../core/with-timeout.js'
import { isEphemeralSourcePath } from './temp-paths.js'
import { readCatalogKey } from '../shares/catalog-keys.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getSpace } from '../spaces/space.js'
import { getDrive } from '../spaces/space-drives.js'
import { dedupeFileRows } from './file-dedupe.js'
import { markListIncomplete } from './list-deficits.js'
import { beginListingRead, retainListingMemo, settleListingRead, takeListingMemo } from './listing-memo.js'
import { looseHasOwn, looseListOwn, looseShareFile, looseUnshareFile } from './backends/overlay/loose-publish.js'
import { looseCatalogVersion, looseListPeer, looseTransferActive } from './backends/overlay/loose-downloads.js'
import { listPendingForSpace } from './pending-transfers.js'
import { isOwnerOnline } from '../network/presence-leases.js'
import { LOOSE_SHARE_ID, looseTransferIdFor } from './transfer-id.js'
import { unhashedStatusFor } from './transfer-status.js'
import b4a from 'b4a'
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
  const drive = getDrive(spaceId)
  if (!drive) throw new AppError(CODES.DRIVE_NOT_FOUND, 'Drive not found for space')

  await assertSharableSource(filePath)

  await looseShareFile(spaceId, filePath, fileName || path.basename(filePath))
}

// The display status of a peer-held file, most-progressed first. `copyVerdict` is the on-device
// copy's verified-copy reading, null when there is none. Exported for unit coverage.
/** @internal */
export function peerFileStatus(copyVerdict, pendingRow, ownerOnline, isActive) {
  if (copyVerdict === COPY_VERDICT.MODIFIED) return FILE_STATUS.MODIFIED
  if (copyVerdict) return 'downloaded'
  if (isActive) return 'downloading'
  if (pendingRow?.errorCode) return 'error'
  if (pendingRow) return ownerOnline ? 'paused-interrupted' : 'paused-offline'
  return ownerOnline ? 'remote' : 'unavailable'
}

// What production passes for `deps`; a test passes doubles and counts them.
const productionDeps = {
  listPeer: looseListPeer,
  listPendingForSpace,
  isOwnerOnline,
  transferActive: looseTransferActive,
  verdictForClaim,
  listVerifiedRecordsForShare,
  listLooseDownloadClaims,
  pruneDownloadClaims,
  catalogVersion: looseCatalogVersion,
}

function ownRow(e, localPublicKey, localDriveKeyHex) {
  const hashed = !!e.contentHash
  // Still hashing → 'publishing' (server-truth) so it survives a navigate-away/remount, not just
  // the optimistic client row.
  return {
    path: '/' + e.relPath, size: e.size, hash: e.contentHash || '', inPlace: true,
    owner: { displayName: 'You', publicKey: localPublicKey || localDriveKeyHex },
    driveKey: localDriveKeyHex, localBytes: hashed ? e.size : 0, isAvailable: true, status: hashed ? 'mine' : 'publishing',
  }
}

// Owner advertised before hashing finished → 'preparing' while reachable, else 'unavailable' (the
// frozen null-hash placeholder can never complete once the owner is offline).
function unhashedPeerRow(member, e, ownerOnline) {
  return {
    path: '/' + e.relPath, size: e.size, hash: '', inPlace: true,
    owner: { displayName: member.displayName, publicKey: member.publicKey },
    driveKey: member.driveKey, localBytes: 0, isAvailable: ownerOnline,
    status: unhashedStatusFor(ownerOnline),
  }
}

// One peer-held row. Synchronous: every fact is a prefetched map, an in-memory engine read or a
// stat, so the loop over every row never yields. A stale claim is collected, never deleted here.
function peerRow(spaceId, member, e, ctx) {
  const drivePath = '/' + e.relPath
  const claim = ctx.claims.get(drivePath) || null
  const verdict = ctx.deps.verdictForClaim(spaceId, drivePath, claim, e.contentHash, ctx.dirProbe)
  if (verdict.prune) ctx.stale.set(drivePath, verdict.reason)
  if (verdict.downloaded) ctx.held.add(drivePath)
  const copyVerdict = verdict.downloaded
    ? verifiedCopyVerdict(ctx.verified.get(e.relPath) || null, verdict.stat ?? null, {
      contentHash: e.contentHash, expectedSize: e.size, expectLocal: claimedPathFor(drivePath, claim),
    })
    : null
  // Status is derived here (single source of truth): an in-flight fetch is 'downloading',
  // otherwise the durable pending row decides paused-*/error. The renderer never overrides it.
  const isActive = ctx.deps.transferActive(spaceId, e.relPath)
  const pendingRow = ctx.pending.get(drivePath)
  return {
    path: drivePath, size: e.size, hash: e.contentHash, inPlace: true,
    owner: { displayName: member.displayName, publicKey: member.publicKey },
    driveKey: member.driveKey, localBytes: copyVerdict ? e.size : 0,
    isAvailable: ctx.ownerOnline, status: peerFileStatus(copyVerdict, pendingRow, ctx.ownerOnline, isActive), verified: copyVerdict === COPY_VERDICT.VERIFIED,
    pendingBytes: pendingRow?.bytesTransferred, errorCode: isActive ? undefined : pendingRow?.errorCode,
    transferId: looseTransferIdFor(spaceId, e.relPath),
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

// Interactive fan-out: every member's catalog is read at once, each under the short interactive
// budget, so the listing costs one budget in total however many members are unreachable. A member
// whose read fails contributes no rows instead of failing the listing. A catalog whose version has
// not moved since its last complete read is served from the listing memo instead.
async function readPeerEntries(spaceId, member, { budget, space, deps }) {
  const { keyHex } = readCatalogKey(member)
  let prior = null
  try {
    const version = await deps.catalogVersion(spaceId, member, { space })
    const memo = takeListingMemo(spaceId, keyHex, version, { fullReadEvery: getListFullReadEvery() })
    if (memo.entries) return memo.entries
    log.debug('loose catalog read for', keyHex.slice(0, 16) + '...', '-', memo.reason)
    prior = beginListingRead(spaceId, keyHex, memo.reason)
    return settleListingRead(spaceId, keyHex, await deps.listPeer(spaceId, member, { timeoutMs: budget, space }), prior)
  } catch (err) {
    // Flag the space the way a stalled read does: without this the convergence tick has no
    // reason to re-poke, so a member whose read threw would stay missing from the listing
    // until some unrelated files-updated arrived.
    markListIncomplete(spaceId)
    log.warn('loose catalog read failed for', member.publicKey.slice(0, 16) + '...', '-', err.message)
    return settleListingRead(spaceId, keyHex, null, prior)
  }
}

// In-place loose files (own + each peer's) read from the loose catalog, shaped like drive-backed
// candidates so dedupeFileRows merges them with the rest.
async function collectLooseInPlace(spaceId, members, { localPublicKey, localDriveKeyHex, space, deps }) {
  if (!isInPlaceFilesEnabled()) return []
  const out = (await looseListOwn(spaceId)).map((e) => ownRow(e, localPublicKey, localDriveKeyHex))
  const peerMembers = (members || []).filter((m) => m?.publicKey && m.publicKey !== localPublicKey && readCatalogKey(m).keyHex)
  retainListingMemo(spaceId, new Set(peerMembers.map((m) => readCatalogKey(m).keyHex)))
  if (peerMembers.length === 0) return out
  const pending = new Map((await deps.listPendingForSpace(spaceId)).map((p) => [p.filePath, p]))
  const budget = interactiveReadTimeoutMs()
  const spaceRecord = space || await getSpace(spaceId)
  const peerEntries = await Promise.all(peerMembers.map((member) => readPeerEntries(spaceId, member, { budget, space: spaceRecord, deps })))
  const { verified, claims } = await prefetchLooseRowState(spaceId, peerEntries, deps)

  const stale = new Map() // drivePath -> the verdict's reason
  const held = new Set()
  const dirProbe = createDirProbe()
  // Member order is the dedupe tie-break, so the fold must see candidates in this order.
  for (const [i, member] of peerMembers.entries()) {
    const ctx = { deps, verified, claims, pending, stale, held, dirProbe, ownerOnline: deps.isOwnerOnline(member.publicKey) }
    for (const e of peerEntries[i]) out.push(e.contentHash ? peerRow(spaceId, member, e, ctx) : unhashedPeerRow(member, e, ctx.ownerOnline))
  }
  // A claim is keyed by name, not by owner: one member's replaced file must not prune the claim
  // another member's row in this same listing reads as downloaded.
  const prune = [...stale.keys()].filter((drivePath) => !held.has(drivePath))
  for (const drivePath of prune) log.info('reset on-device claim (' + stale.get(drivePath) + '):', drivePath)
  // Awaited so a caller can observe the flush, caught so a failed cache cleanup never fails the
  // listing the rows are already built for.
  if (prune.length) await deps.pruneDownloadClaims(spaceId, prune).catch((err) => log.debug('claim prune failed:', err.message))
  return out
}

// `space` is the caller's already-read record, so a listing costs one spaces-bee read, not two.
export async function listFiles(spaceId, members, { space = null, deps = productionDeps } = {}) {
  // The local per-space drive holds no file blobs (overlay serves in place); it is
  // still read for the local driveKey that attributes own loose rows.
  const localDrive = getDrive(spaceId)
  if (!localDrive) return []

  const localDriveKeyHex = b4a.toString(localDrive.key, 'hex')
  const localPublicKey = getLocalPublicKeyHex()

  const files = dedupeFileRows(await collectLooseInPlace(spaceId, members, { localPublicKey, localDriveKeyHex, space, deps }))
  log.debug('listed', files.length, 'files in space', spaceId, '(' + members?.length, 'members)')
  return files
}

export async function removeFile(spaceId, filePath) {
  // Unshare regardless of the inPlaceFiles flag: addFile always publishes loose
  // (overlay is the only path), so gating the unshare on the flag would leave a
  // file permanently shared if the flag were ever off.
  if (await looseHasOwn(spaceId, filePath)) {
    await looseUnshareFile(spaceId, filePath)
    return
  }
  // Not a loose file we own — clear any download-history claim for it.
  await forgetFileRecords(spaceId, filePath)
  log.info('file removed:', filePath, 'from space', spaceId)
}
