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
import { dedupeFileRows } from './file-dedupe.js'
import { markListIncomplete } from './list-deficits.js'
import { beginListingRead, retainListingMemo, settleListingRead, takeListingMemo } from './listing-memo.js'
import { looseHasOwn, looseListOwn, looseShareFile, looseUnshareFile } from './backends/overlay/loose-publish.js'
import { looseCatalogVersion, looseListPeer, looseTransferActive } from './backends/overlay/loose-downloads.js'
import { listPendingForSpace } from './pending-transfers.js'
import { isOwnerOnline } from '../network/presence-leases.js'
import { LOOSE_SHARE_ID, looseTransferIdFor } from './transfer-id.js'
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

  await looseShareFile(spaceId, filePath, fileName || path.basename(filePath))
}

const NO_CLAIM = Object.freeze({ downloaded: false, prune: false })

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

function ownRow(e, localPublicKey) {
  const hashed = !!e.contentHash
  // Still hashing → 'publishing' (server-truth) so it survives a navigate-away/remount, not just
  // the optimistic client row.
  return {
    path: '/' + e.relPath, size: e.size, hash: e.contentHash || '', inPlace: true,
    owner: { displayName: 'You', publicKey: localPublicKey },
    localBytes: hashed ? e.size : 0, isAvailable: true, status: hashed ? FILE_STATUS.MINE : FILE_STATUS.PUBLISHING,
  }
}

// One peer-held row. Synchronous: every fact is a prefetched map, an in-memory engine read or a
// stat, so the loop over every row never yields. A stale claim is collected, never deleted here.
// A claim and a live slot are keyed by name alone and only the content hash ties either to this
// owner's file, so an unhashed entry reads neither; a pending row names its owner, so it counts only
// for that owner's row.
function peerRow(spaceId, member, e, ctx) {
  const drivePath = '/' + e.relPath
  const hashed = Boolean(e.contentHash)
  const claim = ctx.claims.get(drivePath) || null
  const verdict = hashed ? ctx.deps.verdictForClaim(spaceId, drivePath, claim, e.contentHash, ctx.dirProbe) : NO_CLAIM
  if (verdict.prune) ctx.stale.set(drivePath, verdict.reason)
  if (verdict.downloaded) ctx.held.add(drivePath)
  const copyVerdict = verdict.downloaded
    ? verifiedCopyVerdict(ctx.verified.get(e.relPath) || null, verdict.stat ?? null, {
      contentHash: e.contentHash, expectedSize: e.size, expectLocal: claimedPathFor(drivePath, claim),
    })
    : null
  const pendingRow = ctx.pending.get(drivePath)
  const row = consumerRowStatusFor({
    copyVerdict,
    onDeviceStatus: FILE_STATUS.DOWNLOADED,
    hashed,
    isActive: hashed && ctx.deps.transferActive(spaceId, e.relPath),
    pendingRow: pendingRow?.ownerKey === member.publicKey ? pendingRow : undefined,
    ownerOnline: ctx.ownerOnline,
  })
  return {
    path: drivePath, size: e.size, hash: e.contentHash || '', inPlace: true,
    owner: { displayName: member.displayName, publicKey: member.publicKey },
    localBytes: copyVerdict ? e.size : 0, isAvailable: ctx.ownerOnline,
    status: row.status, verified: row.verified || false, pendingBytes: row.pendingBytes, errorCode: row.errorCode,
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

// One member's catalog, under the fan-out's budget. A member whose read fails contributes no rows
// instead of failing the listing. A catalog whose version has not moved since its last complete read
// is served from the listing memo instead.
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

// In-place loose files (own + each peer's) read from the loose catalog, one candidate row per
// owner, so dedupeFileRows can merge them.
async function collectLooseInPlace(spaceId, members, { localPublicKey, space, deps }) {
  const out = (await looseListOwn(spaceId)).map((e) => ownRow(e, localPublicKey))
  const peerMembers = peerMembersOf(members, localPublicKey, (m) => Boolean(readCatalogKey(m).keyHex))
  retainListingMemo(spaceId, new Set(peerMembers.map((m) => readCatalogKey(m).keyHex)))
  if (peerMembers.length === 0) return out
  const pending = new Map((await deps.listPendingForSpace(spaceId)).map((p) => [p.filePath, p]))
  const peerEntries = await readEachPeer(peerMembers, (member, budget) => readPeerEntries(spaceId, member, { budget, space, deps }))
  const { verified, claims } = await prefetchLooseRowState(spaceId, peerEntries, deps)

  const stale = new Map() // drivePath -> the verdict's reason
  const held = new Set()
  const dirProbe = createDirProbe()
  // Member order is the dedupe tie-break, so the fold must see candidates in this order.
  for (const [i, member] of peerMembers.entries()) {
    const ctx = { deps, verified, claims, pending, stale, held, dirProbe, ownerOnline: deps.isOwnerOnline(member.publicKey) }
    for (const e of peerEntries[i]) out.push(peerRow(spaceId, member, e, ctx))
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
/** @param {string} spaceId @param {object[]} members @param {{ space?: StoredSpace | null, deps?: typeof productionDeps }} [opts] */
export async function listFiles(spaceId, members, { space = null, deps = productionDeps } = {}) {
  const spaceRecord = space || await getSpace(spaceId)
  if (!isParticipating(spaceRecord)) return []

  const files = dedupeFileRows(await collectLooseInPlace(spaceId, members, { localPublicKey: getLocalPublicKeyHex(), space: spaceRecord, deps }))
  log.debug('listed', files.length, 'files in space', spaceId, '(' + members?.length, 'members)')
  return files
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
