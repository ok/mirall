// What a space's files look like to the renderer, and the two verbs that change that set.
//
// A loose file has no single source of truth: the owner's catalog says it exists, the claim bee
// says whether we have it, the pending row says whether it is moving, and the disk decides whether
// "on your device" is still true. The listing is where those are folded into one row per file.

import { isDownloadedFile, isVerifiedDownload, forgetFileRecords } from './files.js'
import { createLogger } from '../core/logger.js'

import { entryRef } from '../contract/entry-ref.js'
import { CODES } from '../contract/errors.js'
import { AppError } from '../core/errors.js'
import { isInPlaceFilesEnabled } from '../core/runtime-config.js'
import { interactiveReadTimeoutMs } from '../core/with-timeout.js'
import { isEphemeralSourcePath } from './temp-paths.js'
import { readCatalogKey } from '../shares/catalog-keys.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getSpace } from '../spaces/space.js'
import { getDrive } from '../spaces/space-drives.js'
import { dedupeFileRows } from './file-dedupe.js'
import { markListIncomplete } from './list-deficits.js'
import { looseHasOwn, looseListOwn, looseShareFile, looseUnshareFile } from './backends/overlay/loose-publish.js'
import { looseListPeer, looseTransferActive } from './backends/overlay/loose-downloads.js'
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

// The display status of a peer-held file, most-progressed first. Exported for unit coverage.
/** @internal */
export function peerFileStatus(downloaded, pendingRow, ownerOnline, isActive) {
  if (downloaded) return 'downloaded'
  if (isActive) return 'downloading'
  if (pendingRow?.errorCode) return 'error'
  if (pendingRow) return ownerOnline ? 'paused-interrupted' : 'paused-offline'
  return ownerOnline ? 'remote' : 'unavailable'
}

// In-place loose files (own + each peer's) read from the loose catalog, shaped
// like drive-backed candidates so dedupeFileRows merges them with the rest.
async function collectLooseInPlace(spaceId, members, localPublicKey, localDriveKeyHex) {
  if (!isInPlaceFilesEnabled()) return []
  const out = []
  for (const e of await looseListOwn(spaceId)) {
    if (!e.contentHash) {
      // Still hashing — surface as 'publishing' (server-truth) so it survives a
      // navigate-away/remount, not just the optimistic client row.
      out.push({
        path: '/' + e.relPath, size: e.size, hash: '', inPlace: true,
        owner: { displayName: 'You', publicKey: localPublicKey || localDriveKeyHex },
        driveKey: localDriveKeyHex, localBytes: 0, isAvailable: true, status: 'publishing',
      })
      continue
    }
    out.push({
      path: '/' + e.relPath, size: e.size, hash: e.contentHash, inPlace: true,
      owner: { displayName: 'You', publicKey: localPublicKey || localDriveKeyHex },
      driveKey: localDriveKeyHex, localBytes: e.size, isAvailable: true, status: 'mine',
    })
  }
  const peerMembers = (members || []).filter((m) => m?.publicKey && m.publicKey !== localPublicKey && readCatalogKey(m).keyHex)
  if (peerMembers.length === 0) return out
  const pending = new Map((await listPendingForSpace(spaceId)).map((p) => [p.filePath, p]))
  // Interactive fan-out (files:list): every member's catalog is read AT ONCE, each under the
  // short interactive budget, so the list costs one budget in total — not one per unreachable
  // member (the same shape as share-registry's share:list). A member whose read fails
  // contributes no rows instead of failing the listing; it self-heals on the next
  // event:files-updated once that peer's catalog replicates. Resolve the space record ONCE and
  // thread it into looseListPeer so its per-member SCK lookup doesn't re-read the record M
  // times per files:list (refetched on every event:files-updated).
  const budget = interactiveReadTimeoutMs()
  const space = await getSpace(spaceId)
  const peerEntries = await Promise.all(peerMembers.map(async (member) => {
    try {
      return await looseListPeer(spaceId, member, { timeoutMs: budget, space })
    } catch (err) {
      // Flag the space the way a stalled read does: without this the convergence tick has no
      // reason to re-poke, so a member whose read threw would stay missing from the listing
      // until some unrelated files-updated arrived.
      markListIncomplete(spaceId)
      log.warn('loose catalog read failed for', member.publicKey.slice(0, 16) + '...', '-', err.message)
      return []
    }
  }))
  // Row mapping stays sequential in member order: claim verification has side effects
  // (stale-claim pruning) and dedupeFileRows breaks ties by candidate order.
  for (const [i, member] of peerMembers.entries()) {
    const ownerOnline = isOwnerOnline(member.publicKey)
    for (const e of peerEntries[i]) {
      const drivePath = '/' + e.relPath
      if (!e.contentHash) {
        // Owner advertised before hashing finished → 'preparing' while reachable, else 'unavailable'
        // (the frozen null-hash placeholder can never complete once the owner is offline).
        out.push({
          path: drivePath, size: e.size, hash: '', inPlace: true,
          owner: { displayName: member.displayName, publicKey: member.publicKey },
          driveKey: member.driveKey, localBytes: 0, isAvailable: ownerOnline,
          status: unhashedStatusFor(ownerOnline),
        })
        continue
      }
      const downloaded = await isDownloadedFile(spaceId, drivePath, e.contentHash)
      const verified = downloaded && await isVerifiedDownload(spaceId, entryRef(LOOSE_SHARE_ID, e.relPath), e.contentHash)
      // Status is derived here (single source of truth): an in-flight fetch is 'downloading',
      // otherwise the durable pending row decides paused-*/error. The renderer never overrides it.
      const isActive = looseTransferActive(spaceId, e.relPath)
      const pendingRow = pending.get(drivePath)
      out.push({
        path: drivePath, size: e.size, hash: e.contentHash, inPlace: true,
        owner: { displayName: member.displayName, publicKey: member.publicKey },
        driveKey: member.driveKey, localBytes: downloaded ? e.size : 0,
        isAvailable: ownerOnline, status: peerFileStatus(downloaded, pendingRow, ownerOnline, isActive), verified,
        pendingBytes: pendingRow?.bytesTransferred, errorCode: isActive ? undefined : pendingRow?.errorCode,
        transferId: looseTransferIdFor(spaceId, e.relPath),
      })
    }
  }
  return out
}

export async function listFiles(spaceId, members) {
  // The local per-space drive holds no file blobs (overlay serves in place); it is
  // still read for the local driveKey that attributes own loose rows.
  const localDrive = getDrive(spaceId)
  if (!localDrive) return []

  const localDriveKeyHex = b4a.toString(localDrive.key, 'hex')
  const localPublicKey = getLocalPublicKeyHex()

  const files = dedupeFileRows(await collectLooseInPlace(spaceId, members, localPublicKey, localDriveKeyHex))
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
