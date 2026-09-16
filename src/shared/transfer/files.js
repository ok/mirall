// File-level operations for a space: the local `downloads-meta` bee (downloaded-copy
// claims, hash-verified records, owned-source paths), the add/remove entry points for
// loose files, the aggregated file listing (rows folded by file-dedupe), and
// reveal-in-file-manager. "On your device" is always re-verified against
// the disk before it is reported — the bee rows are claims, the file is the truth.
//
// The `downloads-meta` bee holds three namespaces, distinguished by prefix rather than by
// separator, so a scan of one must not see another:
//   <spaceId>:<filePath>            the downloaded-copy claim
//   verified:<spaceId>:<key>        a hash-verified record: { hash, at, local, mtime, ino }
//   src:<spaceId>:<filePath>        the owned source path of a loose file: { sourcePath, addedAt }
import { verifiedPrefix } from '../contract/entry-ref.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'

import { createLocalBee, storeEpoch } from '../core/store.js'

import fs from 'bare-fs'
import path from 'bare-path'

import { getGlobalDownloadDir, getSpaceDownloadOverride, isInsideDownloadDir } from '../core/paths.js'

import { claimVerdict } from './download-claim.js'
import { prefixRange } from '../core/bee-keys.js'

// Reveal keeps its address here: the IPC layer reaches a file's on-disk location through this
// module, and the resolution it needs is the claim path this bee records.

const log = createLogger('files')

let downloadsBee
let downloadsStore = -1

/** @internal production opens downloads through this file's own _open() */
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
//
// `local` is where the bytes actually landed, addressed the way the writer addresses them: the
// mount-relative path for a mirror, the absolute final path for a manual download. The key names
// the OWNER's path, and neither writer is obliged to use it — a mirror renames onto a free sibling
// when a user file holds the natural name — so only `local` says which file the hash describes.
//
// `stat` fingerprints the exact file the hash was proven against — mtime floored to the integer-ms
// resolution this record stores, plus the inode — so the fast path can demand the SAME file back
// rather than merely one no newer than the record. It must be the stat the content was proven
// against, never a fresher re-stat: a re-stat fingerprints bytes nobody checked. A caller that
// cannot stat passes none, and the record falls back to the weaker rule below.
export async function markVerified(spaceId, key, hash, { local = null, stat = null } = {}) {
  const fingerprint = stat ? { mtime: Math.floor(stat.mtimeMs), ino: Number(stat.ino) || 0 } : {}
  await downloadsBee.put('verified:' + spaceId + ':' + key, { hash, at: Date.now(), local, ...fingerprint })
}

// The hash this app last verified for `key`, or null. `expectLocal` is the path the caller is asking
// about, and it takes the same grammar as isVerifiedUnchanged: pass it whenever the answer is about
// one FILE rather than about the owner's path, and a record written for anywhere else answers null.
//
// The key names the OWNER's path, which two writers addressing `local` differently both write — a
// mirror in mount-relative form, a manual download as an absolute path in the downloads folder — so
// without it the answer is "some local path held this content", not "this file does."
export async function getVerifiedHash(spaceId, key, { expectLocal = null } = {}) {
  const rec = await getVerifiedRecord(spaceId, key)
  if (!rec) return null
  if (expectLocal !== null && rec.local !== expectLocal) return null
  return rec.hash || null
}

// Bulk form of getVerifiedHash for one share: relPath -> verified hash, in a single
// range scan. The space-storage summary joins this map against the owner's catalog
// to sum a mirror's on-device bytes without stat'ing each file. The map is transient
// and worker-only (never serialized over IPC); for a fully-mirrored huge share it
// holds O(files) short strings — bounded, unlike retaining full row arrays.
export async function listVerifiedForShare(spaceId, shareId, { keep = null } = {}) {
  const prefix = verifiedPrefix(spaceId, shareId)
  const map = new Map()
  for await (const node of downloadsBee.createReadStream(prefixRange(prefix))) {
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
  for await (const node of downloadsBee.createReadStream(prefixRange(prefix))) {
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
// Drops a single file's claim AND its owned-source record — what a removal leaves behind on the
// bee. Exported so the listing half can retire a file without reaching for the bee itself.
export async function forgetFileRecords(spaceId, filePath) {
  await downloadsBee.del(spaceId + ':' + filePath)
  await downloadsBee.del('src:' + spaceId + ':' + filePath)
}

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

// True when the verified-download record proves the on-disk file (described by `stat`) is still the
// unchanged content of `contentHash`/`expectedSize` without re-reading it: same hash, same size, and
// the same file the record fingerprinted — same mtime, same inode. `key` = `<shareId>|<relPath>`.
//
// Equality, not "no newer than the record": `at` is stamped AFTER the bytes land, so a file merely
// older than it is every mtime-preserving restore there is (cp -p, rsync -t, tar -x, a backup
// restore). Nothing else ever re-reads a mirrored file — a foreign mount has no watcher and the
// full-walk backstop hits this same short-circuit — so anything admitted here is admitted for the
// life of the mount.
//
// Still a proxy, and deliberately so: a same-size write that leaves both mtime and inode untouched
// (a coarse-granularity filesystem, an in-place write inside its resolution) slips past, the cost of
// not hashing on every check. `ctime` would catch that and is NOT used: it also moves on metadata
// alone — xattrs, Finder tags, quarantine flags, antivirus — which would re-hash the whole mirror
// on a tick, the CPU cost this fast path exists to remove.
//
// `expectLocal` is the path the caller is asking about; pass it whenever the record's key does not
// by itself prove which file the hash describes (see markVerified). A record written before the
// landing path was recorded carries none, so it vouches for nothing and the caller falls back to a
// hash — transient, and healed by the next landing or confirmation, which rewrites the record.
export async function isVerifiedUnchanged(spaceId, key, contentHash, expectedSize, stat, { expectLocal = null } = {}) {
  if (!contentHash || !stat) return false
  if (typeof expectedSize === 'number' && stat.size !== expectedSize) return false
  let rec = null
  try { rec = await getVerifiedRecord(spaceId, key) } catch { return false }
  if (!rec || rec.hash !== contentHash) return false
  if (expectLocal !== null && rec.local !== expectLocal) return false
  // A record written before the fingerprint existed carries none. It keeps the older, weaker rule
  // rather than forcing a re-hash of every already-mirrored file the first time a build with this
  // check runs; the next landing or confirmation replaces it with a fingerprinted one.
  if (typeof rec.mtime !== 'number') return Math.floor(stat.mtimeMs) <= rec.at
  if (Math.floor(stat.mtimeMs) !== rec.mtime) return false
  // Compared only when both sides report one: a filesystem that does not expose a stable inode
  // reports 0, and reading that as a mismatch would re-hash every file on every tick.
  if (rec.ino && stat.ino && Number(stat.ino) !== rec.ino) return false
  return true
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

export async function clearOwnedSource(spaceId, filePath) {
  await downloadsBee.del('src:' + spaceId + ':' + filePath)
}

// Where a claim's file lives. `localPath` is authoritative — a collision-avoiding
// download may not sit at <root>/<basename>. Rows written before localPath existed have
// no recorded path; those can only ever have landed under the GLOBAL root, since
// per-space roots did not exist when they were written.
export function claimedPathFor(filePath, rec) {
  return rec?.localPath || path.join(getGlobalDownloadDir(), path.basename(filePath))
}

export async function cleanupDownloadHistory(spaceId) {
  const batch = downloadsBee.batch()
  for await (const entry of downloadsBee.createReadStream(prefixRange(spaceId + ':'))) {
    await batch.del(entry.key)
  }
  for await (const entry of downloadsBee.createReadStream(prefixRange('verified:' + spaceId + ':'))) {
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
