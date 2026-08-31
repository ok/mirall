// File-level operations for a space: the local `downloads-meta` bee (downloaded-copy
// claims, hash-verified records, owned-source paths), the add/remove entry points for
// loose files, the aggregated file listing (one row per content hash; the most-progressed
// copy wins), and reveal-in-file-manager. "On your device" is always re-verified against
// the disk before it is reported — the bee rows are claims, the file is the truth.
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { getDrive, getSpace } from '../spaces/space.js'
import { readCatalogKey } from '../shares/share-catalog.js'
import { createLocalBee, storeEpoch } from '../core/store.js'
import { isOwnerOnline } from './swarm.js'
import { listPendingForSpace } from './pending-transfers.js'
import { markListIncomplete } from './list-deficits.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { AppError, ErrorCodes } from '../core/errors.js'
import { isEphemeralSourcePath } from '../folders/temp-paths.js'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import os from 'bare-os'
import { spawn } from 'bare-subprocess'
import { getDownloadDir, getGlobalDownloadDir, getSpaceDownloadOverride, isInsideDownloadDir } from '../core/paths.js'
import { isInPlaceFilesEnabled } from '../core/runtime-config.js'
import { interactiveReadTimeoutMs } from '../core/with-timeout.js'
import { revealExitIsFailure } from './reveal-exit.js'
import { looseShareFile, looseUnshareFile, looseHasOwn, looseListOwn, looseListPeer, looseTransferActive } from './loose-overlay.js'
import { LOOSE_SHARE_ID, looseTransferIdFor } from './transfer-id.js'
import { unhashedStatusFor } from './transfer-status.js'
import { claimVerdict } from './download-claim.js'

const log = createLogger('files')

let downloadsBee
let downloadsStore = -1

export async function initDownloads() {
  if (downloadsBee && downloadsStore === storeEpoch() && !downloadsBee.core.closed) return
  downloadsStore = storeEpoch()
  downloadsBee = createLocalBee('downloads-meta')
  await downloadsBee.ready()
  log.info('download history initialized')
}

export async function markDownloaded(spaceId, filePath, localPath = null, meta = {}) {
  // Persist the ACTUAL landed path — a collision-avoiding download may not live
  // at <Downloads>/<basename>, so reveal/status must use this, not a recomputed
  // basename. Also record the content `hash` so the claim can tell a
  // still-current copy from a stale one after the owner replaces the file.
  await downloadsBee.put(spaceId + ':' + filePath, {
    downloadedAt: Date.now(),
    localPath,
    hash: meta.hash || null,
  })
  log.info('marked as downloaded:', filePath, 'in space', spaceId)
}

export async function getDownloadedPath(spaceId, filePath) {
  const entry = await downloadsBee.get(spaceId + ':' + filePath)
  return entry?.value?.localPath || null
}

// Records that a file's bytes were hash-verified equal to `hash` on landing
// (overlay downloads verify the content hash incrementally during the transfer).
// `key` identifies the file within the space (e.g. `<shareId>|<relPath>`). Kept
// under a `verified:` namespace; cleaned per-space by cleanupDownloadHistory.
export async function markVerified(spaceId, key, hash) {
  await downloadsBee.put('verified:' + spaceId + ':' + key, { hash, at: Date.now() })
}

export async function getVerifiedHash(spaceId, key) {
  const entry = await downloadsBee.get('verified:' + spaceId + ':' + key)
  return entry?.value?.hash || null
}

// Bulk form of getVerifiedHash for one share: relPath -> verified hash, in a single
// range scan. The space-storage summary joins this map against the owner's catalog
// to sum a mirror's on-device bytes without stat'ing each file. The map is transient
// and worker-only (never serialized over IPC); for a fully-mirrored huge share it
// holds O(files) short strings — bounded, unlike retaining full row arrays.
export async function listVerifiedForShare(spaceId, shareId, { keep = null } = {}) {
  const prefix = 'verified:' + spaceId + ':' + shareId + '|'
  const map = new Map()
  for await (const node of downloadsBee.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    const relPath = node.key.slice(prefix.length)
    if (keep && !keep.has(relPath)) continue
    if (node.value?.hash) map.set(relPath, node.value.hash)
  }
  return map
}

// Bulk form of the downloaded-claim read for one share: drivePath -> claim record, in a single
// range scan. The share listing needs the same record up to three times per row; one scan answers
// every row.
//
// `keep` bounds RETENTION, not the scan. A listing renders at most listFilesCap rows, so holding a
// claim for a row nobody will see is memory spent on nothing. It also settles the share-name prefix
// question: a share named 'a' scans the claims of a share named 'a/b' too — their keys are
// genuinely under that prefix — and those are dropped here, where a lookup by exact drivePath
// could never have matched them anyway.
export async function listDownloadClaimsForShare(spaceId, shareName, { keep = null } = {}) {
  const prefix = spaceId + ':/' + shareName + '/'
  const map = new Map()
  for await (const node of downloadsBee.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    const drivePath = node.key.slice(spaceId.length + 1)
    if (keep && !keep.has(drivePath)) continue
    if (node.value) map.set(drivePath, node.value)
  }
  return map
}

// Prune the claims a listing found stale, in ONE batch after its rows are assembled. Deferred out
// of the row loop because a del is a WRITE: inline, a read path took a write turn per stale row.
//
// Best-effort by design and never rethrown into the listing: a claim is a cache of a fact the disk
// owns, so a failed prune costs one more re-check on the next listing, never correctness. A listing
// that failed because its own cleanup failed would be the worse bug.
export async function pruneDownloadClaims(spaceId, drivePaths) {
  if (!drivePaths.length) return 0
  const batch = downloadsBee.batch()
  try {
    for (const drivePath of drivePaths) await batch.del(spaceId + ':' + drivePath)
    await batch.flush()
  } catch (err) {
    try { await batch.close() } catch {}
    log.debug('claim prune failed:', err.message)
    return 0
  }
  log.info('pruned', drivePaths.length, 'stale on-device claims')
  return drivePaths.length
}

async function getVerifiedRecord(spaceId, key) {
  const entry = await downloadsBee.get('verified:' + spaceId + ':' + key)
  return entry?.value || null
}

// True when the verified-download record proves the on-disk file (described by
// `stat`) is still the unchanged content of `contentHash`/`expectedSize` without
// re-reading it: same hash, same size, and mtime not advanced past when we recorded
// it (floored to the record's integer-ms resolution so a sub-ms write→record gap
// still matches). It is an mtime proxy — a same-size in-place edit that does not
// advance mtime (a backdated utimes, or a coarse-granularity FS) can slip past; the
// deliberate cost of not hashing on every check. `key` = `<shareId>|<relPath>`.
export async function isVerifiedUnchanged(spaceId, key, contentHash, expectedSize, stat) {
  if (!contentHash || !stat) return false
  if (typeof expectedSize === 'number' && stat.size !== expectedSize) return false
  let rec = null
  try { rec = await getVerifiedRecord(spaceId, key) } catch { return false }
  return !!rec && rec.hash === contentHash && Math.floor(stat.mtimeMs) <= rec.at
}

// A downloaded overlay file is "verified" when the hash recorded on landing (the
// overlay verifies it byte-for-byte during transfer) still equals the currently
// advertised content hash. key = `<shareId>|<relPath>` (loose uses LOOSE_SHARE_ID).
export async function isVerifiedDownload(spaceId, key, contentHash) {
  if (!contentHash) return false
  return (await getVerifiedHash(spaceId, key)) === contentHash
}

// Answers "does this folder exist?" once per folder instead of once per claim.
//
// The probe only runs for a claim whose FILE is missing, so on a healthy volume it never runs at
// all. The case it exists for is the opposite one: a detached or unreachable volume, where every
// row misses and every miss is a blocking probe against a dead mount — a capped listing would pay
// thousands of them for a question with one answer. Downloads are flat, so those thousands of
// claims resolve into a handful of directories at most.
//
// The memo lives exactly one listing: callers create a probe per pass and drop it, so a volume that
// comes back is seen by the next listing. Within one pass a single answer is also the CORRECT one —
// the row loop is synchronous and the listing already renders one consistent snapshot.
export function createDirProbe() {
  const seen = new Map()
  return (dir) => {
    let present = seen.get(dir)
    if (present === undefined) {
      present = fs.existsSync(dir)
      seen.set(dir, present)
    }
    return present
  }
}

// "Downloaded / on your device" must reflect bytes ACTUALLY present on disk, and — for a
// space that pins its own download folder — inside that folder. The downloads-meta record
// is only a hint; the file is the truth.
//
// The filesystem + config half of that decision; download-claim.js holds the rule and the order.
// Synchronous: every fact it needs is a stat or an in-memory config read, so a batched listing can
// call it per row without the loop yielding. `dirExists` is resolved ONLY when the file is missing,
// so the common case still costs one existsSync. A caller looping over many claims passes a
// `dirProbe` from createDirProbe so the folder question is asked once per folder, not once per row;
// the default keeps the single-claim callers on a plain probe.
export function verdictForClaim(spaceId, filePath, rec, currentHash = null, dirProbe = fs.existsSync) {
  if (!rec) return claimVerdict({ rec: null })
  const onDisk = claimedPathFor(filePath, rec)
  const exists = fs.existsSync(onDisk)
  const pinned = getSpaceDownloadOverride(spaceId)
  return claimVerdict({
    rec,
    exists,
    dirExists: exists ? true : dirProbe(path.dirname(onDisk)),
    currentHash,
    pinned,
    insidePinned: pinned ? isInsideDownloadDir(onDisk, pinned) : true,
  })
}

// The point-read form: one claim, read and acted on. Built on the same verdict as the batched
// listing path so the two can never drift.
async function verifyOnDevice(spaceId, filePath, currentHash = null) {
  const key = spaceId + ':' + filePath
  const node = await downloadsBee.get(key)
  if (!node) return false
  const verdict = verdictForClaim(spaceId, filePath, node.value || {}, currentHash)
  if (verdict.prune) {
    await downloadsBee.del(key)
    log.info('reset on-device claim (' + verdict.reason + '):', filePath)
  } else if (verdict.reason === 'volume-unavailable') {
    log.debug('claim folder unavailable, keeping claim:', filePath)
  } else if (verdict.reason === 'outside-space-folder') {
    log.debug('claim outside the space download folder:', filePath)
  }
  return verdict.downloaded
}

export async function isDownloadedFile(spaceId, filePath, currentHash = null) {
  return await verifyOnDevice(spaceId, filePath, currentHash)
}

// Strict form for callers that DROP work when the answer is yes (the resume scan's
// completed-row guard): the claim must name the same content hash we are being asked about.
// verifyOnDevice compares hashes only when BOTH sides carry one, so a hashless claim — an older
// record, or a loose intent row — would otherwise answer "downloaded" for content it has never
// seen and the pending row would be discarded instead of fetched.
export async function isDownloadedWithHash(spaceId, filePath, contentHash) {
  if (!contentHash) return false
  const node = await downloadsBee.get(spaceId + ':' + filePath)
  if (node?.value?.hash !== contentHash) return false
  return await verifyOnDevice(spaceId, filePath, contentHash)
}

// For a file you OWN (added/shared by you, never downloaded), remember where its
// local source lives so "Open in folder" reveals the real file instead of
// guessing <Downloads>/<basename>. Kept under a separate `src:` key namespace so
// it never trips the downloaded check (which would mis-flag a peer copy as "downloaded").
export async function markOwnedSource(spaceId, filePath, sourcePath) {
  await downloadsBee.put('src:' + spaceId + ':' + filePath, { sourcePath, addedAt: Date.now() })
}

export async function getOwnedSourcePath(spaceId, filePath) {
  const entry = await downloadsBee.get('src:' + spaceId + ':' + filePath)
  return entry?.value?.sourcePath || null
}

export async function* listOwnedSources(spaceId) {
  const gte = 'src:' + spaceId + ':'
  for await (const node of downloadsBee.createReadStream({ gte, lt: gte + '\xff' })) {
    const sourcePath = node.value?.sourcePath
    if (sourcePath) yield { drivePath: node.key.slice(gte.length), sourcePath }
  }
}

export async function clearOwnedSource(spaceId, filePath) {
  await downloadsBee.del('src:' + spaceId + ':' + filePath)
}

// A dropped item must resolve to a real, persistent file before we publish it.
// Rejects in-memory-only drops (empty path), macOS promised-file temp locations
// (unsaved screenshots / Photo Booth captures), and anything that isn't a
// readable file on disk. Without this, addFile would happily stream an ephemeral
// source that vanishes moments later, leaving the share pointing at nothing.
export async function assertSharableSource(filePath) {
  if (!filePath || isEphemeralSourcePath(filePath)) {
    throw new AppError(ErrorCodes.SOURCE_NOT_ON_DISK, 'File is not saved on disk')
  }
  let stat
  try {
    stat = await fs.promises.stat(filePath)
  } catch {
    throw new AppError(ErrorCodes.SOURCE_NOT_ON_DISK, 'File is not saved on disk')
  }
  if (!stat.isFile()) {
    throw new AppError(ErrorCodes.SOURCE_NOT_ON_DISK, 'File is not saved on disk')
  }
}

export async function addFile(spaceId, filePath, fileName) {
  const drive = getDrive(spaceId)
  if (!drive) throw new AppError(ErrorCodes.DRIVE_NOT_FOUND, 'Drive not found for space')

  await assertSharableSource(filePath)

  // Loose files are served in place via the overlay (no second copy into a drive).
  await looseShareFile(spaceId, filePath, fileName || path.basename(filePath))
}

const STATUS_PRIORITY = {
  mine: 0,
  downloaded: 1,
  downloading: 2,
  publishing: 2,
  'paused-interrupted': 3,
  'paused-offline': 4,
  remote: 5,
  unavailable: 6,
  error: 7,
}

// The display status of a peer-held file, most-progressed first. Exported for unit coverage.
export function peerFileStatus(downloaded, pendingRow, ownerOnline, isActive) {
  if (downloaded) return 'downloaded'
  if (isActive) return 'downloading'
  if (pendingRow?.errorCode) return 'error'
  if (pendingRow) return ownerOnline ? 'paused-interrupted' : 'paused-offline'
  return ownerOnline ? 'remote' : 'unavailable'
}

// One row per distinct file (by content hash). When the same content is held by several peers,
// the most-progressed copy wins (STATUS_PRIORITY) and the rest become a sharedByCount.
function dedupeByHash(candidates) {
  const byHash = new Map()
  for (const candidate of candidates) {
    const list = byHash.get(candidate.hash)
    if (list) list.push(candidate)
    else byHash.set(candidate.hash, [candidate])
  }

  const files = []
  for (const [, group] of byHash) {
    group.sort((a, b) => STATUS_PRIORITY[a.status] - STATUS_PRIORITY[b.status])
    const winner = group[0]
    const others = group.length - 1
    files.push(others > 0 ? { ...winner, sharedByCount: others } : winner)
  }
  return files
}

// In-place loose files (own + each peer's) read from the loose catalog, shaped
// like drive-backed candidates so dedupeByHash merges them with the rest.
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
      return await looseListPeer(spaceId, member, budget, space)
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
  // (stale-claim pruning) and dedupeByHash breaks ties by candidate order.
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
      const downloaded = await verifyOnDevice(spaceId, drivePath, e.contentHash)
      const verified = downloaded && await isVerifiedDownload(spaceId, LOOSE_SHARE_ID + '|' + e.relPath, e.contentHash)
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

  const files = dedupeByHash(await collectLooseInPlace(spaceId, members, localPublicKey, localDriveKeyHex))
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
  await downloadsBee.del(spaceId + ':' + filePath)
  await downloadsBee.del('src:' + spaceId + ':' + filePath)
  log.info('file removed:', filePath, 'from space', spaceId)
}

// Where a claim's file lives. `localPath` is authoritative — a collision-avoiding
// download may not sit at <root>/<basename>. Rows written before localPath existed have
// no recorded path; those can only ever have landed under the GLOBAL root, since
// per-space roots did not exist when they were written.
export function claimedPathFor(filePath, rec) {
  return rec?.localPath || path.join(getGlobalDownloadDir(), path.basename(filePath))
}

// Where "Open in folder" should point: a downloaded file lives at its landed
// path; a file you own lives at its original source. Only when we know neither
// do we guess <Downloads>/<name> — a last resort, since for an owned file that
// guess points at a Downloads folder the file was never in (which is why
// markOwnedSource records the real source at share time).
export async function resolveRevealTarget(spaceId, filePath) {
  return (await getDownloadedPath(spaceId, filePath))
    || (await getOwnedSourcePath(spaceId, filePath))
    || path.join(getDownloadDir(spaceId), path.basename(filePath))
}

export async function revealFile(spaceId, filePath) {
  return revealLocalPath(await resolveRevealTarget(spaceId, filePath))
}

export function revealLocalPath(target) {
  const platform = os.platform()
  const exists = fs.existsSync(target)
  const folder = path.dirname(target)

  log.info('reveal requested:', target, '(platform:', platform + ', exists:', exists + ')')

  if (!exists && !fs.existsSync(folder)) {
    throw new AppError(ErrorCodes.NOT_FOUND, 'File is not on this device')
  }

  const opts = { stdio: 'ignore', detached: true }
  let child
  try {
    if (platform === 'darwin') {
      child = exists
        ? spawn('open', ['-R', target], opts)
        : spawn('open', [folder], opts)
    } else if (platform === 'win32') {
      child = exists
        ? spawn('explorer.exe', ['/select,', target], opts)
        : spawn('explorer.exe', [folder], opts)
    } else {
      child = spawn('xdg-open', [folder], opts)
    }
  } catch (err) {
    log.error('reveal spawn threw:', err.message)
    throw new AppError(ErrorCodes.UNKNOWN, 'Could not reveal file')
  }

  child.on('error', (err) => log.error('reveal subprocess error:', err.message))
  child.on('exit', (code) => {
    if (revealExitIsFailure(platform, code)) log.warn('reveal exited with code:', code)
  })
  child.unref()
}

export async function cleanupDownloadHistory(spaceId) {
  const batch = downloadsBee.batch()
  for await (const entry of downloadsBee.createReadStream({ gte: spaceId + ':', lt: spaceId + ';' })) {
    await batch.del(entry.key)
  }
  for await (const entry of downloadsBee.createReadStream({ gte: 'verified:' + spaceId + ':', lt: 'verified:' + spaceId + ';' })) {
    await batch.del(entry.key)
  }
  await batch.flush()
  log.info('cleaned download history for space', spaceId)
}

export class DownloadsBee extends Subsystem {
  async _open() { await initDownloads() }

  async _close() {
    const bee = downloadsBee
    downloadsBee = undefined
    await bee?.close()
  }
}
