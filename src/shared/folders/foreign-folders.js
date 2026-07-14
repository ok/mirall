// The mirror engine for foreign folders: another member's share materialized read-only
// to a local mount path. A per-mount loop lists the owner's catalog (the replicated
// file listing) and materializes the diff — files are fetched by content hash through
// the overlay backend and land as partials that rename into place; deletions are
// honored only for files the mirror itself wrote (syncedPaths) and only while the
// owner is provably online, so a lagged replica or a user's own files are never wiped.
import fs from 'bare-fs'
import path from 'bare-path'
import { makeProgressTicker } from '../transfer/progress-ticker.js'
import { shouldIgnore, DEFAULT_IGNORE, shouldHonorDeletions, relToDriveKey, driveKeyToSegments, stripLongPathPrefix, isAbsoluteDriveKey, relKeyEscapes, nextFreeName } from './path-keys.js'

// Re-exported so `test/integration/foreign-del-guard.test.js` keeps its
// `./foreign-folders.js` import path; the implementation lives in `path-keys.js`.
export { shouldHonorDeletions }
import { isOwnerOnline } from '../transfer/swarm.js'
import { getSpace } from '../spaces/space.js'
import { getLocalPublicKeyHex } from '../spaces/profile.js'
import { getResourceCaps } from '../core/runtime-config.js'
import {
  getForeignMount, saveForeignMount, deleteForeignMount, findForeignMountByShareId,
} from './mount-store.js'
import { setMirrorState, tombstoneMirror } from './mirror-records.js'
import { mountRootAvailable } from './owned-folders.js'
import { AppError, ErrorCodes } from '../core/errors.js'
import { getContentBackend, hasContentBackend } from '../transfer/content-backends.js'
import { getOverlay } from '../transfer/backends/overlay/overlay-instance.js'
import { overlayHashFile, makeFetchDiag, setOverlayCatalogChangeHook, overlayHasTransfer } from '../transfer/backends/overlay/overlay-backend.js'
import { shareDecoKey } from '../transfer/decoration-key.js'
import { transferIdFor } from '../transfer/transfer-id.js'
import { PARTIAL_SUFFIX } from '../transfer/partial-suffix.js'
import { markVerified, isVerifiedUnchanged } from '../transfer/files.js'
import { PREVIEW_DETAIL_MAX_FILES, includePerFile } from './preview-detail.js'
import { createLogger } from '../core/logger.js'
import { mapLimit } from '../core/concurrency.js'
import { AbortError } from './walk-disk.js'

const log = createLogger('foreign-folders')

const activeLoops = new Map()
const pendingTicks = new Map()
let ipcRef = null

// The single guarded peer-key -> absolute-path conversion. Every site that turns
// an owner-controlled drive key into a local path goes through this, so no caller
// can forget the containment check: the pure segment guard, then an OS-level
// path.relative belt that catches any escape regardless of separator or encoding.
function safeMaterializePath (mountPath, relPath) {
  if (relKeyEscapes(relPath)) {
    throw new AppError(ErrorCodes.EPATH, `peer file path rejected — unsafe segment escapes the mount folder: ${relPath}`)
  }
  const abs = path.join(mountPath, ...driveKeyToSegments(relPath))
  const rel = path.relative(mountPath, abs)
  if (rel === '' || rel === '..' || rel.startsWith('..' + path.sep) || path.isAbsolute(rel)) {
    throw new AppError(ErrorCodes.EPATH, `peer file path rejected — resolves outside the mount folder: ${relPath}`)
  }
  return abs
}

// Decide the on-disk relPath for a materialized owner entry, never clobbering a
// file Mirall did not create, and idempotently so repeated ticks / re-mounts
// converge on one sibling instead of breeding report (1).pdf, report (2).pdf …
// Same invariant as download-dest.js::resolveDest — a download must never overwrite
// the user's own file or adopt another transfer's orphan partial — but path-key
// aware and persistent (the mapping survives across ticks):
//  1) an established conflict mapping wins — idempotent across ticks;
//  2) nothing on disk, or a path we already synced at its natural name -> natural;
//  3) on-disk bytes already equal the share's hash -> natural (applyChange
//  hash-skips it; this is what lets unmount->re-mount adopt the prior copy);
//  4) a genuine pre-existing user file -> a free sibling, recorded in renamedPaths.
async function resolveLocalRelPath (mount, ownerKey, ownerHash, hashOf = overlayHashFile) {
  const mapped = mount.renamedPaths?.[ownerKey]
  if (mapped) return mapped

  const naturalAbs = safeMaterializePath(mount.mountPath, ownerKey)
  if (!fs.existsSync(naturalAbs) || (mount.syncedPaths || []).includes(ownerKey)) return ownerKey

  // hashOf must match how ownerHash was computed: the overlay hasher for overlay
  // shares — else the adopt-existing-copy check never matches and a collision
  // sibling is minted.
  if (ownerHash) {
    try { if (await hashOf(naturalAbs) === ownerHash) return ownerKey } catch {}
  }

  const segs = driveKeyToSegments(ownerKey)
  const leaf = segs.pop()
  const dir = segs.join('/')
  const isTaken = (name) => {
    const abs = safeMaterializePath(mount.mountPath, dir ? dir + '/' + name : name)
    // A candidate is taken by a real file OR an in-flight partial (what
    // materializeOverlayFile writes), so we never mint a sibling name onto
    // another transfer's partial.
    return fs.existsSync(abs) || fs.existsSync(abs + PARTIAL_SUFFIX)
  }
  const localRel = (dir ? dir + '/' : '') + nextFreeName(leaf, isTaken)
  ;(mount.renamedPaths ||= {})[ownerKey] = localRel
  return localRel
}

// The on-disk relPath an owner key was materialized as (its natural name unless a
// conflict forced a collision-free sibling).
function localRelOf (mount, ownerKey) {
  return mount.renamedPaths?.[ownerKey] || ownerKey
}

// Drop conflict mappings whose owner key the share no longer carries, so the map
// can't accumulate stale entries across ticks.
function pruneRenamedPaths (mount, onDrive) {
  if (!mount.renamedPaths) return
  for (const ownerKey of Object.keys(mount.renamedPaths)) {
    if (!onDrive.has(ownerKey)) delete mount.renamedPaths[ownerKey]
  }
}

// Drop poisoned peer entries at ingest so they never enter syncedPaths or the
// materialize batch — one bad key must not abort the tick or DoS the mirror. This
// guards the catalog source (backend.listPeer).
function dropUnsafeEntries (entries, sourceLabel) {
  return entries.filter((e) => {
    if (relKeyEscapes(e.relPath)) {
      log.warn('refusing a peer file path that escapes the mount folder — skipping this entry (the owner drive may be malicious or corrupted):', e.relPath, '(source:', sourceLabel + ')')
      return false
    }
    return true
  })
}

export function initForeignFolders(_ipc) {
  ipcRef = _ipc
  // Materialize promptly when an owner's catalog appends, instead of waiting for
  // the mirror's poll tick.
  setOverlayCatalogChangeHook(onPeerDriveChanged)
}

function loopKey(spaceId, shareId) {
  return spaceId + ':' + shareId
}

// The owner's content changed. Run a materialize tick now (debounced) for each
// active mirror in that space instead of waiting for the 30s poll, so owner-side
// edits/deletes reflect on the mirror's disk as promptly as they do in the folder
// view.
export function onPeerDriveChanged(spaceId) {
  for (const loop of activeLoops.values()) {
    if (loop.spaceId !== spaceId) continue
    const key = loopKey(loop.spaceId, loop.shareId)
    if (pendingTicks.has(key)) continue
    const timer = setTimeout(() => {
      pendingTicks.delete(key)
      runMaterializeTick(loop.spaceId, loop.shareId).catch((err) => {
        log.debug('append-driven materialize failed:', err.message)
      })
    }, 250)
    timer.unref?.()
    pendingTicks.set(key, timer)
  }
}

async function loadShareForForeignMount(mount) {
  const { readPeerShares } = await import('../shares/shares.js')
  const shares = await readPeerShares(mount.ownerKey, mount.spaceId)
  if (!shares) return null
  const found = shares.find((s) => s.id === mount.shareId)
  if (!found) return null
  return { ...found, spaceId: mount.spaceId, owner: mount.ownerKey }
}

function emitStatus(spaceId, shareId, status, extra) {
  ipcRef?.emit('event:foreign-folder-mount-status', { spaceId, shareId, status, ...(extra || {}) })
}

// Keep the replicated mirror-participation record in step with a mount lifecycle change, then poke
// the local mirror views. A record-write failure must not break the mount operation itself.
async function syncMirrorRecord(spaceId, shareId, op) {
  let changed = false
  try { changed = await op() } catch (err) { log.warn('mirror record update failed:', shareId, '-', err.message) }
  if (changed) ipcRef?.emit('event:mirrors-updated', { spaceId, shareId })
}

// The one place a materialize pass reports its terminal sync state: 'synced' once every catalog
// entry is present locally, else 'syncing'. Callers gen-guard this so a stopped/paused mount's
// trailing tick can't overwrite the pause.
function settleMirrorSyncState(mount, allPresent) {
  return syncMirrorRecord(mount.spaceId, mount.shareId, () => setMirrorState(mount.spaceId, mount.shareId, allPresent ? 'synced' : 'syncing'))
}

// The automatic (recoverable) pause statuses. Named once here and consumed by both
// pauseMountForIoError (the writer) and AUTO_PAUSE_STATUSES (the resume gate), so the two
// can't drift. A user pause ('paused', via setForeignEnabled) is deliberately not in this set.
const STATUS_MOUNT_GONE = 'mount-point-gone'
const STATUS_ENOSPC = 'paused-enospc'
const STATUS_IO_ERROR = 'paused-error'
const AUTO_PAUSE_STATUSES = new Set([STATUS_MOUNT_GONE, STATUS_ENOSPC, STATUS_IO_ERROR])

async function pauseMount(mount, status, reason) {
  mount.enabled = false
  mount.status = status
  await saveForeignMount(mount)
  // Symmetry with the user-pause path (setForeignEnabled(false)): stop the poll loop so an
  // auto-paused mount doesn't keep a live interval, its in-flight fetch is cancelled, and its
  // cancelGen is bumped — the last point lets an in-progress scan bail before it would
  // otherwise overwrite this pause with a trailing status:'active'.
  stopForeignLoop(mount.spaceId, mount.shareId)
  await syncMirrorRecord(mount.spaceId, mount.shareId, () => setMirrorState(mount.spaceId, mount.shareId, 'paused'))
  emitStatus(mount.spaceId, mount.shareId, status, reason ? { reason } : null)
}

// Classify a local I/O failure and pause the mount accordingly (overlay
// materializeOverlayFile write path). Returns true if it paused — the caller then
// stops; false leaves the error for generic handling.
async function pauseMountForIoError(mount, err) {
  if (err?.code === 'ENOSPC') { await pauseMount(mount, STATUS_ENOSPC); return true }
  if (err?.code === 'EACCES' || err?.code === 'EPERM' || err?.code === 'EROFS') { await pauseMount(mount, STATUS_IO_ERROR, err.message); return true }
  if (err?.code === 'ENOENT' && !fs.existsSync(mount.mountPath)) { await pauseMount(mount, STATUS_MOUNT_GONE); return true }
  return false
}

export function isAutoPaused(mount) {
  return !!mount && mount.enabled === false && AUTO_PAUSE_STATUSES.has(mount.status)
}

// Probe-driven twin of pauseMountForIoError for a mount whose local path vanished while the
// poll loop was idle: nothing touched the destination, so no I/O error ever classified the
// fault and the durable status stayed a stale 'active' that a refresh/boot would resurrect.
// No-ops for a user pause, an already-applied auto-pause, or a path that is actually present.
export async function autoPauseForeignMountGone(spaceId, shareId) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount || mount.enabled === false) return false
  if (mountRootAvailable(mount.mountPath)) return false
  await pauseMount(mount, STATUS_MOUNT_GONE)
  return true
}

// Level-triggered recovery for an auto-paused mirror: the local target returned, the disk
// was freed, or a permission was fixed. Re-enables via the canonical enable path, which drives an
// immediate materialize through the serialized tick (not a bare initial scan) so it can't race the
// poll loop and can't leave a trailing status:'active'; if the fault still holds, that tick's
// write re-pauses it. A user pause and a still-missing path are left untouched.
export async function resumeAutoPausedForeignMount(spaceId, shareId) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!isAutoPaused(mount)) return false
  if (!mountRootAvailable(mount.mountPath)) return false
  await setForeignEnabled(spaceId, shareId, true)
  return true
}

// The containment-guarded materialize primitive. safeMaterializePath rejects any
// owner-controlled relPath that escapes the mount BEFORE any local write/unlink —
// the path-traversal guard the security suite exercises (foreign-path-containment).
// Puts are fetched by the overlay path (materializeOverlayFile); this remains the
// delete primitive used by the catalog deletion reconcile.
export async function applyChange(mount, change) {
  const abs = safeMaterializePath(mount.mountPath, change.localRelPath || change.relPath)
  if (change.action === 'del') {
    try { await fs.promises.unlink(abs) } catch (err) {
      if (err && err.code !== 'ENOENT') throw err
    }
    ipcRef?.emit('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
  }
}

export async function initialMaterializeScan(mount) {
  const share = await loadShareForForeignMount(mount)
  if (share && hasContentBackend(share)) return await initialMaterializeScanCatalog(mount, share)
  // No usable content backend (unsupported / unreadable share) — skip the mirror
  // rather than materialize from a path this build can't serve. Still settle the record
  // so it doesn't advertise 'syncing' forever for a mount that can never fetch.
  log.warn('skipping mirror — no usable content backend:', share?.contentMode, mount.shareId)
  await settleMirrorSyncState(mount, true)
  return { skipped: 'no-content-backend' }
}

const FOREIGN_PREVIEW_CONCURRENCY = 8
const PREVIEW_PROGRESS_EVERY = 16

// Resolve the peer share and enumerate its files from the overlay catalog.
// Returns null when the share isn't visible / has no usable content backend.
async function loadForeignListing(spaceId, ownerKey, shareId) {
  const { readPeerShares } = await import('../shares/shares.js')
  const shares = await readPeerShares(ownerKey, spaceId)
  if (!shares) return null
  const found = shares.find((s) => s.id === shareId)
  if (!found) return null
  const share = { ...found, spaceId, owner: ownerKey }
  if (!hasContentBackend(share)) return null
  const backend = getContentBackend(share)
  const { entries } = await backend.listPeerWithMeta(spaceId, share)
  return dropUnsafeEntries(entries.map((e) => ({ relPath: e.relPath, size: e.size, hash: e.contentHash })), 'preview')
}

// Outcome of one remote entry vs the destination, preserving the original loop's
// semantics: absent -> download (no conflict); present but different -> download +
// conflict; present and identical -> skip. A size mismatch alone proves a conflict
// (different bytes can't hash-equal), and a verified-cache hit proves identity, so a
// content hash is read only for a same-size, uncached file. A non-ENOENT stat error
// means the file exists but is unreadable -> treat as a conflict.
async function classifyForeignEntry(entry, mountPath, spaceId, shareId, hashOf) {
  const abs = safeMaterializePath(mountPath, entry.relPath)
  let stat = null
  try {
    stat = await fs.promises.stat(abs)
  } catch (err) {
    if (err && err.code === 'ENOENT') return { relPath: entry.relPath, size: entry.size, download: true, conflict: false }
    return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  }
  if (!stat.isFile()) return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  if (stat.size !== entry.size) return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  if (entry.hash && await isVerifiedUnchanged(spaceId, shareId + '|' + entry.relPath, entry.hash, entry.size, stat)) {
    return { relPath: entry.relPath, size: entry.size, download: false }
  }
  try {
    const onDisk = await hashOf(abs)
    if (entry.hash && onDisk === entry.hash) return { relPath: entry.relPath, size: entry.size, download: false }
    return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  } catch {
    return { relPath: entry.relPath, size: entry.size, download: true, conflict: true }
  }
}

export async function previewMaterializeScan(spaceId, ownerKey, shareId, mountPath, opts = {}) {
  const { onProgress = null, signal = null, hashOf = overlayHashFile } = opts
  const checkAborted = () => { if (signal && signal.aborted) throw new AbortError() }
  const emit = (phase, scanned, total) => { if (onProgress) { try { onProgress({ phase, scanned, total, bytes: 0 }) } catch {} } }

  // Local count (disk) and remote listing (network) are independent — overlap them.
  emit('enumerating', 0, 0)
  const [existingAtDestination, entries] = await Promise.all([
    countFilesAtPath(mountPath),
    loadForeignListing(spaceId, ownerKey, shareId),
  ])
  checkAborted()

  if (!entries) {
    return { flow: 'mount-foreign-folder', toUpload: 0, toDownload: 0, conflicts: 0, existingAtDestination, totalBytes: 0, perFile: [] }
  }

  let scanned = 0
  const results = await mapLimit(entries, FOREIGN_PREVIEW_CONCURRENCY, async (entry) => {
    checkAborted()
    const r = await classifyForeignEntry(entry, mountPath, spaceId, shareId, hashOf)
    scanned += 1
    if (scanned % PREVIEW_PROGRESS_EVERY === 0) emit('scanning', scanned, entries.length)
    return r
  })
  emit('scanning', entries.length, entries.length)

  let toDownload = 0
  let conflicts = 0
  let totalBytes = 0
  const candidates = []
  for (const r of results) {
    if (!r.download) continue
    toDownload += 1
    if (r.conflict) conflicts += 1
    totalBytes += r.size
    if (candidates.length <= PREVIEW_DETAIL_MAX_FILES) candidates.push({ relPath: r.relPath, size: r.size, conflict: !!r.conflict })
  }

  const detailed = includePerFile(toDownload)
  return {
    flow: 'mount-foreign-folder',
    toUpload: 0,
    toDownload,
    conflicts,
    existingAtDestination,
    totalBytes,
    perFile: detailed ? candidates : [],
    perFileOmitted: !detailed,
  }
}

async function countFilesAtPath(target) {
  try {
    const entries = await fs.promises.readdir(target, { recursive: true, withFileTypes: true })
    // Same Windows `\\?\` long-path normalization as walkDisk (walk-disk.js):
    // strip the extended-length prefix from both sides so a prefixed parentPath
    // can't make path.relative emit an absolute path and throw the file count off.
    const cleanTarget = stripLongPathPrefix(target)
    let count = 0
    for (const entry of entries) {
      if (!entry.isFile()) continue
      const dir = entry.parentPath ?? entry.path ?? target
      const rel = relToDriveKey(path.relative(cleanTarget, stripLongPathPrefix(path.join(dir, entry.name))), path.sep)
      if (rel === '..' || rel.startsWith('../') || isAbsoluteDriveKey(rel)) continue
      // Ignore OS junk / temp files (.DS_Store, Thumbs.db, our own partials, …). The
      // sync engine never touches them, and counting hidden files the user
      // can't even see in Finder makes "N files already at the destination"
      // wrong (a viewed folder always has a hidden .DS_Store).
      if (!rel || shouldIgnore(rel, DEFAULT_IGNORE)) continue
      count += 1
    }
    return count
  } catch {
    return 0
  }
}

export async function startForeignLoop(mount) {
  const key = loopKey(mount.spaceId, mount.shareId)
  if (activeLoops.has(key)) return

  const timer = setInterval(() => {
    runMaterializeTick(mount.spaceId, mount.shareId).catch((err) => {
      log.debug('materialize tick failed:', err.message)
    })
  }, getResourceCaps().foreignPollIntervalMs)
  timer.unref?.()
  activeLoops.set(key, { timer, spaceId: mount.spaceId, shareId: mount.shareId })
}

const tickInFlight = new Map()
const tickDirty = new Set()
// Bumped by stopForeignLoop (pause / unmount). A long initial scan or poll tick
// over thousands of files captures the generation at its start and bails between
// files once it changes — otherwise the pass runs to completion (and its trailing
// saveForeignMount can even resurrect an unmounted mount).
const cancelGen = new Map()
// The file the mirror is fetching right now (one per loopKey — the catalog materialize is
// strictly sequential): contentHash so stopForeignLoop can abort the in-flight overlay
// download, relPath so foreignFetchActive can identify the row.
const activeOverlayFetches = new Map()
// contentHash a pause left holders showing us paused for, after its in-flight fetch slot was
// released — lets a later unmount tell the holder we stopped rather than leaving its "who is
// downloading" row paused until the 5-min sweep. Mirrors overlay-download's pausedHashes.
const pausedMirrorHashes = new Map()
function mirrorGen(key) { return cancelGen.get(key) || 0 }

// Is the mirror loop actively fetching THIS row? Consulted by the worker's share:list-files
// derivation so a materializing mirror row reports 'downloading'.
export function foreignFetchActive(spaceId, shareId, relPath) {
  return activeOverlayFetches.get(loopKey(spaceId, shareId))?.relPath === relPath
}
function mirrorStopped(key, gen) { return mirrorGen(key) !== gen }

// Serialize ticks per mount: the poll and the append-driven trigger must never
// run concurrently, or overlapping ticks act on stale drive snapshots and
// re-materialize files the other just deleted. A request that arrives while a
// tick runs sets a dirty flag so exactly one follow-up tick runs after it.
export async function runMaterializeTick(spaceId, shareId) {
  const key = loopKey(spaceId, shareId)
  if (tickInFlight.has(key)) {
    tickDirty.add(key)
    return tickInFlight.get(key)
  }
  const p = materializeOnce(spaceId, shareId).finally(() => {
    tickInFlight.delete(key)
    if (tickDirty.delete(key)) runMaterializeTick(spaceId, shareId).catch(() => {})
  })
  tickInFlight.set(key, p)
  return p
}

async function materializeOnce(spaceId, shareId) {
  const current = await getForeignMount(spaceId, shareId)
  if (!current || !current.enabled) return
  // The owner's share metadata can be momentarily unreadable (profile bee not
  // replicated this instant) or gone (owner deleted the share). A periodic /
  // append-driven tick must skip quietly in that case — not throw on every
  // fire, which floods the log once the append trigger runs ticks frequently.
  const share = await loadShareForForeignMount(current)
  if (!share) {
    await maybeUnmountIfOwnerGone(current)
    return
  }
  if (hasContentBackend(share)) return await materializeOnceCatalog(current, share)
  // No usable content backend (unsupported / unreadable mode) — don't mirror, but settle the
  // record so it doesn't advertise 'syncing' forever.
  log.debug('skipping mirror tick — no usable content backend:', share.contentMode, shareId)
  await settleMirrorSyncState(current, true)
}

// Route one catalog entry to the read-to-mount: overlay fetches straight from a
// holder by content hash (no peer drive to stream from).
export async function materializeCatalogFile(mount, share, entry, opts = {}) {
  return await materializeOverlayFile(mount, share, entry, opts)
}

// Classify an overlay-mirror fetch that produced no file (fetchFile → null).
// fetchFile returns null for TWO reasons: no holder was ever reachable (no chunk
// scheduler ran), or a holder WAS asked but the transfer stalled / all peers
// vanished mid-stream (its internal catch swallows that into null). Only the
// latter is a genuine give-up worth a WARN; the former is a benign "retry next
// tick" (debug). `attempted` is true once a scheduler ran — i.e. the fetch's
// onEnd fired. Exported for unit coverage of the give-up/no-holder split.
export function classifyMirrorMiss(attempted) {
  return attempted ? 'failed' : 'no-holder'
}

// Overlay share: the bytes never enter a drive, so the mirror fetches the file by
// its content hash straight to the mount path (hash-verified by the overlay). No
// ensureRemote/release handshake — the holder serves on demand, gated by the
// serve ACL. A null contentHash means the owner is still hashing; retry next tick.
// A local I/O failure pauses the mount via the shared pauseMountForIoError
// classification (full disk / permission / vanished mount); anything else is a
// logged fetch miss.
async function handleOverlayMirrorFetchError(mount, entry, err, diag) {
  if (await pauseMountForIoError(mount, err)) return
  diag.finish('failed')
  if (err?.code === 'EHASHMISMATCH') log.warn('overlay mirror integrity failure — holder served bytes not matching the content hash:', entry.relPath)
  else log.debug('overlay mirror fetch failed:', entry.relPath, '-', err.message)
}

async function materializeOverlayFile(mount, share, entry, opts = {}) {
  const hashOf = opts.hashOf || overlayHashFile
  const verifyKey = mount.shareId + '|' + entry.relPath
  // Overlay content hashes are leaf/size-prefixed, NOT plain blake2b — compare
  // the on-disk copy with the overlay hasher, or the skip/adopt checks never
  // match and the mirror re-fetches every file every tick.
  const localRelPath = await resolveLocalRelPath(mount, entry.relPath, entry.contentHash, hashOf)
  const abs = safeMaterializePath(mount.mountPath, localRelPath)
  let onDisk = null
  try { onDisk = await fs.promises.stat(abs) } catch {}
  if (onDisk?.isFile() && entry.contentHash) {
    // Already-mirrored file: the verified record skips the full re-hash the poll
    // would otherwise run over every file each tick; only hash on a cache miss.
    if (await isVerifiedUnchanged(mount.spaceId, verifyKey, entry.contentHash, entry.size, onDisk)) return 'present'
    try {
      if (await hashOf(abs) === entry.contentHash) {
        await markVerified(mount.spaceId, verifyKey, entry.contentHash)
        return 'present'
      }
    } catch (err) { log.debug('overlay hash skipped on disk:', err.message) }
  }
  if (!entry.contentHash) return 'missing'
  // A manual download of the same file may already be in flight on the folder engine
  // (mounted mid-download): fetching it here too would interleave two producers on one
  // decoration key and duplicate the bytes — skip; the next tick lands it after the
  // engine settles.
  if (overlayHasTransfer(transferIdFor(mount.spaceId, mount.shareId, entry.relPath))) return 'missing'
  const overlay = getOverlay()
  if (!overlay) return 'missing'
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  // Mirror download bar with speed/ETA. The overlay scheduler reports CUMULATIVE
  // bytes; ticker.pushTo diffs them.
  const total = entry.size || 0
  const decoKey = shareDecoKey(mount.shareId, entry.relPath)
  const ticker = makeProgressTicker(total, ({ bytes, speed, eta }) => {
    ipcRef?.emit('event:decoration', {
      channel: 'transfer', spaceId: mount.spaceId, key: decoKey, bytes, total, speed, eta,
    })
  })
  const diag = makeFetchDiag('overlay mirror', entry.relPath, total, entry.contentHash)
  let attempted = false // set once a chunk scheduler runs — i.e. a holder was found and asked
  let res
  const streamKey = loopKey(mount.spaceId, mount.shareId)
  activeOverlayFetches.set(streamKey, { contentHash: entry.contentHash, relPath: entry.relPath })
  pausedMirrorHashes.delete(streamKey) // a fresh/resumed fetch supersedes any paused-stop marker
  // The row just flipped to 'downloading' (foreignFetchActive) — poke the list re-derive.
  ipcRef?.emit('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
  try {
    res = await overlay.fetchFile(entry.contentHash, {
      destPath: abs,
      reSeed: false,
      onProgress: (b) => { ticker.pushTo(b); diag.onProgress(b) },
      onVerify: (fraction) => ipcRef?.emit('event:decoration', {
        channel: 'transfer', spaceId: mount.spaceId, key: decoKey, phase: 'verifying', verifyFraction: fraction, bytes: 0, total,
      }),
      onEnd: (info) => { attempted = true; diag.onEnd(info) },
    })
  } catch (err) {
    // ECANCELLED is a deliberate pause/unmount abort (stopForeignLoop), not a
    // give-up: log it as a stop and keep whatever partial cancelFetch chose to keep.
    if (err?.code === 'ECANCELLED') { diag.finish('paused'); return 'missing' }
    await handleOverlayMirrorFetchError(mount, entry, err, diag)
    return 'missing'
  } finally {
    activeOverlayFetches.delete(streamKey)
    // Every settle (done/miss/error/pause) re-derives the row off the now-cleared fetch slot
    // and terminally clears the row's decoration — unless a manual download of the same file
    // started on the folder engine meanwhile (it now owns the decoration key; clearing it here
    // would blank its live bar).
    ipcRef?.emit('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
    if (!overlayHasTransfer(transferIdFor(mount.spaceId, mount.shareId, entry.relPath))) {
      ipcRef?.emit('event:decoration', { channel: 'transfer', spaceId: mount.spaceId, key: decoKey, done: true })
    }
  }
  // null = nothing fetched: a stall after a holder was asked is a give-up (WARN);
  // never reaching a holder is a benign retry-next-tick (debug).
  if (!res) { diag.finish(classifyMirrorMiss(attempted)); return 'missing' }
  diag.finish('done')
  // a local hit returns the source path without writing abs — copy the bytes by
  // path (never buffering a possibly multi-GB file in memory).
  if (res.local && res.destPath !== abs) {
    try { fs.copyFileSync(res.destPath, abs) } catch (err) { log.debug('overlay mirror local-copy failed:', entry.relPath, '-', err.message); return 'missing' }
  }
  // The transfer verified the content hash on landing — record it so the row can
  // surface a "verified" indicator without re-hashing.
  await markVerified(mount.spaceId, verifyKey, entry.contentHash)
  return 'present'
}

async function initialMaterializeScanCatalog(mount, share) {
  const key = loopKey(mount.spaceId, mount.shareId)
  const gen = mirrorGen(key)
  const { entries: raw, complete } = await getContentBackend(share).listPeerWithMeta(mount.spaceId, share)
  const entries = dropUnsafeEntries(raw, 'catalog-initial')
  let allPresent = true
  const synced = []
  for (const entry of entries) {
    if (mirrorStopped(key, gen)) return { stopped: true }
    synced.push(entry.relPath)
    try {
      if (await materializeCatalogFile(mount, share, entry) === 'missing') allPresent = false
    } catch (err) {
      allPresent = false
      log.debug('catalog initial materialize failed:', entry.relPath, '-', err.message)
    }
  }
  if (mirrorStopped(key, gen)) return { stopped: true }
  // An incomplete drain is a partial view of the owner's catalog, so it may not SHRINK the synced
  // record — union instead, or a mirror that already holds 12 files forgets 8 of them on a
  // truncated re-scan (and with it the evidence a later deletion would be judged against). Only a
  // complete read is authoritative enough to replace the record, or to stamp the scan done.
  mount.syncedPaths = complete ? synced : [...new Set([...(mount.syncedPaths || []), ...synced])]
  if (complete) mount.initialScanCompletedAt = Date.now()
  mount.status = 'active'
  await saveForeignMount(mount)
  emitStatus(mount.spaceId, mount.shareId, 'active')
  // Skip the terminal state on an empty or partial listing: at mount the owner's catalog may not
  // have replicated yet, and publishing 'synced' with zero (or truncated) entries would falsely
  // show a fully-merged mirror. A genuinely-empty share settles to 'synced' on a later tick. The
  // gen recheck (adjacent to the enqueue, no await between) stops a concurrent pause from being
  // overwritten.
  if (!mirrorStopped(key, gen) && entries.length > 0 && complete) await settleMirrorSyncState(mount, allPresent)
  return {}
}

async function materializeOnceCatalog(mount, share) {
  const key = loopKey(mount.spaceId, mount.shareId)
  const gen = mirrorGen(key)
  const { entries: raw, complete } = await getContentBackend(share).listPeerWithMeta(mount.spaceId, share)
  const entries = dropUnsafeEntries(raw, 'catalog-tick')
  const onDrive = new Map(entries.map((e) => [e.relPath, e]))
  const renamedBefore = Object.keys(mount.renamedPaths || {}).length
  let allPresent = true
  for (const [, entry] of onDrive) {
    if (mirrorStopped(key, gen)) return
    try {
      if (await materializeCatalogFile(mount, share, entry) === 'missing') allPresent = false
    } catch (err) {
      allPresent = false
      log.debug('catalog materialize failed:', entry.relPath, '-', err.message)
    }
  }

  if (mirrorStopped(key, gen)) return

  const honorDeletions = shouldHonorDeletions({
    ownerOnline: isOwnerOnline(mount.ownerKey),
    driveCount: onDrive.size,
    listingComplete: complete,
  })
  const synced = new Set(mount.syncedPaths || [])
  if (honorDeletions) {
    for (const ownerKey of synced) {
      if (relKeyEscapes(ownerKey)) {
        log.warn('refusing to honor a stored sync path that escapes the mount folder — skipping deletion:', ownerKey)
        continue
      }
      if (!onDrive.has(ownerKey)) await applyChange(mount, { action: 'del', relPath: ownerKey, localRelPath: localRelOf(mount, ownerKey) })
    }
    mount.syncedPaths = [...onDrive.keys()]
    pruneRenamedPaths(mount, onDrive)
    await saveForeignMount(mount)
  } else {
    const before = synced.size
    for (const ownerKey of onDrive.keys()) synced.add(ownerKey)
    if (synced.size !== before || Object.keys(mount.renamedPaths || {}).length !== renamedBefore) {
      mount.syncedPaths = [...synced]
      await saveForeignMount(mount)
    }
  }
  // Re-check the generation adjacent to the enqueue (no await between) so a pause/unmount that
  // landed during the deletion-reconcile await above can't be overwritten by this terminal write.
  if (!mirrorStopped(key, gen)) await settleMirrorSyncState(mount, allPresent)
}

// A mount whose share is no longer in the owner's live list is usually just a transient
// replication gap — but the orphaned mirror must be torn down (stop the loop, drop the mount;
// materialized files stay on disk, matching owner-delete behaviour) once the owner is gone for good,
// in either of two ways: the owner LEFT the space (no longer in space.members — robust even when its
// tombstone never replicates, e.g. an offline leaver), or the owner DELETED the share (profile-bee
// tombstone). A genuinely-unreadable share whose owner is still a member is left alone to retry.
async function maybeUnmountIfOwnerGone(mount) {
  if (await ownerLeftSpace(mount.spaceId, mount.ownerKey)) {
    log.info('owner left space — unmounting orphaned mirror', mount.shareId, '(files kept on disk)')
    await unmountForeignFolder(mount.spaceId, mount.shareId)
    return
  }
  const { readPeerShareEntry } = await import('../shares/shares.js')
  const raw = await readPeerShareEntry(mount.ownerKey, mount.spaceId, mount.shareId)
  if (raw && raw.deletedAt) {
    log.info('owner removed share', mount.shareId, '— unmounting orphaned mirror (files kept on disk)')
    await unmountForeignFolder(mount.spaceId, mount.shareId)
  }
}

// Positive evidence only: true when we hold the space's member list and the owner is absent from it
// (left, or fold-dropped). Unknown/not-yet-loaded membership returns false so a boot/transient gap
// never triggers a spurious unmount.
async function ownerLeftSpace(spaceId, ownerKey) {
  // Our own share (self-mirror) — we never "leave" our own space; space.members lists OTHERS only.
  if (ownerKey === getLocalPublicKeyHex()) return false
  const space = await getSpace(spaceId)
  if (!space || !Array.isArray(space.members)) return false
  return !space.members.some((m) => m.publicKey === ownerKey)
}

export function stopForeignLoop(spaceId, shareId, { discardPartial = false } = {}) {
  const key = loopKey(spaceId, shareId)
  // Invalidate any in-flight scan/tick (it bails at the next file) and abort the
  // file currently downloading, so pause/unmount stops the sync now — not after
  // the whole folder finishes materialising.
  cancelGen.set(key, mirrorGen(key) + 1)
  // Overlay-catalog in-flight fetch: cancel by content hash. discardPartial:false
  // (pause) keeps the partial + journal so the next tick resumes; true (unmount)
  // unlinks it. cancelFetch also tells the holder we paused/stopped, so its
  // "who is downloading" indicator clears now rather than on the idle sweep. A pause
  // releases the fetch slot while the holder still shows us paused, so remember the hash
  // and, on a later unmount with no live fetch, notify the holder we stopped.
  const inflight = activeOverlayFetches.get(key)
  if (inflight) {
    try { getOverlay()?.cancelFetch(inflight.contentHash, { discardPartial }) } catch {}
    activeOverlayFetches.delete(key)
    if (discardPartial) pausedMirrorHashes.delete(key)
    else pausedMirrorHashes.set(key, inflight.contentHash)
  } else if (discardPartial) {
    const paused = pausedMirrorHashes.get(key)
    if (paused) { try { getOverlay()?.notifyTransferStopped(paused) } catch {} }
    pausedMirrorHashes.delete(key)
  }
  tickDirty.delete(key)
  const handle = activeLoops.get(key)
  if (handle) {
    clearInterval(handle.timer)
    activeLoops.delete(key)
  }
  const pending = pendingTicks.get(key)
  if (pending) {
    clearTimeout(pending)
    pendingTicks.delete(key)
  }
}

export async function unmountForeignFolder(spaceId, shareId) {
  stopForeignLoop(spaceId, shareId, { discardPartial: true })
  // Overlay copies no bytes into a drive (it serves straight from the owner's
  // source), so there is no per-share blob cache to reclaim on unmount — the
  // materialized files stay on disk, matching owner-delete behaviour.
  await deleteForeignMount(spaceId, shareId)
  await syncMirrorRecord(spaceId, shareId, () => tombstoneMirror(spaceId, shareId))
  emitStatus(spaceId, shareId, 'idle')
  ipcRef?.emit('event:share-files-updated', { spaceId, shareId })
}

export async function setForeignEnabled(spaceId, shareId, enabled) {
  const mount = await getForeignMount(spaceId, shareId)
  if (!mount) throw new AppError(ErrorCodes.NOT_FOUND, 'Mount not found')
  const wasEnabled = mount.enabled !== false
  mount.enabled = enabled
  mount.status = enabled ? 'active' : 'paused'
  await saveForeignMount(mount)
  if (enabled) {
    await startForeignLoop(mount)
    // Only a genuine resume (was paused) touches the record and re-evaluates now: set 'syncing',
    // then kick an immediate tick so a mirror with nothing left to fetch settles straight back to
    // 'synced' instead of blinking for a whole poll interval. A redundant enable of an already-
    // active mount must not blink 'synced'->'syncing'.
    if (!wasEnabled) {
      await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, 'syncing'))
      runMaterializeTick(spaceId, shareId).catch((err) => log.debug('foreign resume tick failed:', shareId, '-', err.message))
    }
  } else {
    stopForeignLoop(spaceId, shareId)
    await syncMirrorRecord(spaceId, shareId, () => setMirrorState(spaceId, shareId, 'paused'))
  }
  emitStatus(spaceId, shareId, mount.status)
  return mount
}

export async function findForeignMount(shareId) {
  return await findForeignMountByShareId(shareId)
}
