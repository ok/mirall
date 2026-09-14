// The per-entry fetch: everything between "the pass decided it wants this file" and "the bytes are
// at the natural name".
//
// It is separate from the pass because it owns what a pass must not: the one in-flight fetch per
// mount, the paused-stop markers left with holders, the per-(file, hash) attempt budget and the
// integrity rows. A pass can be abandoned and restarted; these survive it.

import path from 'bare-path'
import fs from 'bare-fs'
import { createPausedHolders } from '../transfer/backends/overlay/paused-holders.js'
import { getOverlay } from '../transfer/backends/overlay/overlay-instance.js'
import { createIntegritySeen } from './integrity-seen.js'
import { createAttemptBudget } from './fetch-attempts.js'
import { getSpace } from '../spaces/space.js'
import { record } from '../audit/audit-log.js'
import { selfActor, spaceRef, targetRef } from '../audit/audit-record.js'
import { OUTCOME, TARGET_KIND } from '../contract/audit-kinds.js'
import { createLogger } from '../core/logger.js'

import { shareDecoKey } from '../contract/decoration-key.js'
import { entryRef } from '../contract/entry-ref.js'
import { CODES } from '../contract/errors.js'
import { AppError } from '../core/errors.js'
import { getResourceCaps } from '../core/runtime-config.js'
import { claimFetch, dropFetchClaim, fetchClaimedBy } from '../transfer/backends/overlay/fetch-claims.js'
import { classifyMiss, isTerminalFault } from '../transfer/backends/overlay/fetch-policy.js'
import { runOverlayFetch } from '../transfer/backends/overlay/fetch-run.js'
import { FETCH_OWNER_MIRROR, acquireFetchSlot } from '../transfer/backends/overlay/fetch-slots.js'
import { overlayHashFile } from '../transfer/backends/overlay/overlay-backend.js'
import { getVerifiedHash, isVerifiedUnchanged, markVerified } from '../transfer/files.js'
import { freeBytesFor } from '../transfer/free-space-probe.js'
import { shortfall } from '../transfer/free-space.js'
import { PARTIAL_SUFFIX } from '../transfer/partial-suffix.js'
import { pathFromMount } from './path-guard.js'
import { transferIdFor } from '../transfer/transfer-id.js'
import { pauseMount, pauseMountForIoError } from './foreign-pause.js'
import { classifyLocalCopy, mayOverwriteInPlace } from './mirror-ownership.js'
import { STATUS_MOUNT_GONE, statusForFaultCode } from './mount-fault.js'
import { conflictCopyName, driveKeyToSegments } from './path-keys.js'
import { mountRootAvailable } from './publish-runner.js'

const log = createLogger('mirror-fetch')

// Injected by foreign-folders.js: the loop generation, the per-mount sync state, the IPC handle
// and the pause ladder all belong to the module that owns the mount's life.
let state = null
let loops = null
let getIpc = () => null

export function initMirrorFetch(d) {
  state = d.state
  loops = d.loops
  getIpc = d.getIpc
}

function loopKey(spaceId, shareId) {
  return spaceId + ':' + shareId
}

const mirrorGen = (key) => loops.generationOf(key)
const mirrorStopped = (key, gen) => loops.stopped(key, gen)

// The file the mirror is fetching right now (one per loopKey — the catalog materialize is
// strictly sequential): contentHash so stopForeignLoop can abort the in-flight overlay
// download, relPath so foreignFetchActive can identify the row.
const activeOverlayFetches = new Map()
// The paused-stop markers this mount left with holders, so a later unmount can still tell them we
// stopped rather than leaving their "who is downloading" row paused until the 5-min sweep.
const pausedHolders = createPausedHolders({ notifyStopped: (hash) => getOverlay()?.notifyTransferStopped(hash) })
// Is the mirror loop actively fetching THIS row? Consulted by the worker's share:list-files
// derivation so a materializing mirror row reports 'downloading'.
export function foreignFetchActive(spaceId, shareId, relPath) {
  return activeOverlayFetches.get(loopKey(spaceId, shareId))?.relPath === relPath
}

const integritySeen = createIntegritySeen({
  onCap: (mountKey, limit) => log.warn('mirror integrity rows capped at', limit, 'for', mountKey,
    '— further hash mismatches on this mount are logged but not audited until it is remounted'),
})

// How many times this mount has failed to land a given (file, hash), and when to stop asking.
// Budgeted, not blocked: the overlay is multi-source, and the first holder serving bad bytes must
// not condemn content a second holder can serve. In memory rather than durable — the mirror is
// catalog-driven and must not grow a row per file — so a remount forgives it.
const attempts = createAttemptBudget()

// The ONE thing a mirror audits. contract/audit-kinds.js deliberately records no per-file folder
// sync, and this is not sync bookkeeping: it is a claim about what a member of this space served.
export function recordMirrorIntegrityFailure(mount, share, entry) {
  if (!integritySeen.admit(loopKey(mount.spaceId, mount.shareId), entry.relPath, entry.contentHash)) return
  getSpace(mount.spaceId).then((space) => {
    record('security.integrity_failure', {
      actor: selfActor(),
      space: spaceRef(mount.spaceId, space?.name ?? null),
      target: targetRef(TARGET_KIND.FILE, entry.relPath ?? null, path.basename(entry.relPath || '') || null),
      subject: {
        bytes: entry.size ?? null,
        ownerKey: mount.ownerKey ?? null,
        folder: share?.displayName || share?.name || null,
        shareId: mount.shareId ?? null,
      },
      outcome: OUTCOME.ERROR,
      code: 'TRANSFER_CHECKSUM',
    })
  }).catch((err) => log.debug('mirror integrity audit failed:', err.message))
}

// A mirror is owner-authoritative: the owner's bytes belong at the natural name (pinned by
// mirror-local-edit.test.js) — but never at the cost of the user's. Before the fetch renames over
// the local file, prove it is one we delivered: the verified record is that ancestor and `diskHash`
// is already computed, so the check costs one bee read on a file about to be overwritten anyway.
// Anything we cannot vouch for is moved aside first; the owner's version then lands at the
// canonical path.
async function preserveLocalEdit(mount, entry, verifyKey, diskHash, abs, localRelPath) {
  // Path-qualified: the ancestor authorises overwriting THIS file, so a record written for anywhere
  // else — a manual download of the same share path, which lands in the downloads folder and
  // rewrites the same key — must not answer for it. No record leaves the verdict UNKNOWN, which
  // fails closed into a conflict copy.
  const ancestorHash = await getVerifiedHash(mount.spaceId, verifyKey, { expectLocal: localRelPath }).catch(() => null)
  if (mayOverwriteInPlace(classifyLocalCopy({ diskHash, ownerHash: entry.contentHash, ancestorHash }))) return

  const segs = driveKeyToSegments(entry.relPath)
  const leaf = segs.pop()
  const dir = segs.join('/')
  const isTaken = (name) => {
    const candidate = pathFromMount(mount.mountPath, dir ? dir + '/' + name : name)
    return fs.existsSync(candidate) || fs.existsSync(candidate + PARTIAL_SUFFIX)
  }
  const conflictRel = (dir ? dir + '/' : '') + conflictCopyName(leaf, isTaken)
  try {
    await fs.promises.rename(abs, pathFromMount(mount.mountPath, conflictRel))
    log.warn('mirror conflict on', entry.relPath, '- the local copy was not the one we delivered; kept it as', conflictRel)
  } catch (err) {
    // Could not move it aside, so do not overwrite it either: leaving the mirror one file stale is
    // recoverable on the next tick, and destroying the edit is not.
    log.error('could not preserve a locally-edited mirror file — leaving it untouched:', entry.relPath, '-', err.message)
    throw new AppError(CODES.TRANSFER_PERMISSION, 'could not preserve a local edit')
  }
}

// Overlay share: the bytes never enter a drive, so the mirror fetches the file by
// its content hash straight to the mount path (hash-verified by the overlay). No
// ensureRemote/release handshake — the holder serves on demand, gated by the
// serve ACL. A null contentHash means the owner is still hashing; retry next tick.
// A local I/O failure pauses the mount via the shared pauseMountForIoError
// classification (full disk / permission / vanished mount); anything else is a
// logged fetch miss.
async function handleOverlayMirrorFetchError(mount, share, entry, err, diag) {
  // Order matters: a local I/O fault pauses the mount and is NOT a peer act. Auditing it would
  // blame a holder for our own full disk.
  if (await pauseMountForIoError(mount, err)) return
  diag?.finish('failed')
  const code = err?.code === 'EHASHMISMATCH' ? CODES.TRANSFER_CHECKSUM : null
  if (!code) {
    log.debug('overlay mirror fetch failed:', entry.relPath, '-', err.message)
    return
  }
  log.warn('overlay mirror integrity failure — holder served bytes not matching the content hash:', entry.relPath)
  recordMirrorIntegrityFailure(mount, share, entry)
  // Checksum is the only terminal fault reachable here — every local I/O fault was classified and
  // paused above, and the engine's other two terminal codes describe a destination mountCanTake
  // preflights instead. Charged to a budget rather than blocked outright, so another holder can
  // still serve the same content.
  if (!isTerminalFault(code)) return
  const key = loopKey(mount.spaceId, mount.shareId)
  const spent = attempts.fail(key, entry.relPath, entry.contentHash)
  if (attempts.exhausted(key, entry.relPath, entry.contentHash)) {
    log.warn('mirror stopped asking for a file whose holders keep failing its hash:', entry.relPath, 'after', spent, 'attempts')
  }
}

// Why this entry will not be fetched, or null to go ahead. All three sit BELOW the caller's
// 'present' returns: an unreachable owner and a spent budget must still let a file already on disk
// be adopted, or a fully-mirrored mount can never converge.
export function fetchSkipReason(mount, entry, opts) {
  if (!entry.contentHash) return 'missing'
  if (opts.noFetch) return 'missing'
  // 'blocked', deliberately not 'no-peers': that means "nobody is out there", which ends the whole
  // pass — a corrupt file must not stop the mirror fetching the rest of the folder.
  if (attempts.exhausted(loopKey(mount.spaceId, mount.shareId), entry.relPath, entry.contentHash)) return 'blocked'
  return null
}

// One probe per pass, not one per file. Both questions are about the VOLUME, so asking them per
// catalog entry is thousands of blocking syscalls answering the same thing — the shape
// files.js::createDirProbe already exists for on the listing side.
export function createMountProbe(mount) {
  let root = null
  let free = null
  return {
    rootAvailable: () => (root ??= mountRootAvailable(mount.mountPath)),
    freeBytes: () => (free ??= freeBytesFor(mount.mountPath)),
  }
}

// The same two preflights the download engine runs (download-root-unavailable.test.js pins them
// there). Without the first, fetchOverlayEntry's mkdir -p silently RECREATES a mount root the user
// deleted and materializes into a resurrected empty tree.
//
// They settle differently on purpose. A missing root and an exhausted volume are mount-wide, so
// they pause. A single file that will not fit is about THAT file: pausing the mount for it would
// strand every other file in the folder, and the engine keeps the same decision per row.
async function mountCanTake(mount, entry, abs, probe) {
  if (!probe.rootAvailable()) {
    await pauseMount(mount, STATUS_MOUNT_GONE)
    return false
  }
  const freeBytes = probe.freeBytes()
  // Short of the headroom with nothing requested at all: the volume is out, not this file.
  if (shortfall({ freeBytes, needBytes: 0 }) > 0) {
    await pauseMount(mount, statusForFaultCode(CODES.TRANSFER_DISK_FULL), CODES.TRANSFER_DISK_FULL)
    return false
  }
  // A resumed partial has already taken its bytes from the volume; charging for them twice would
  // refuse a transfer that is nearly done.
  let allocatedBytes = 0
  try { allocatedBytes = fs.statSync(abs + PARTIAL_SUFFIX).blocks * 512 || 0 } catch {}
  if (shortfall({ freeBytes, needBytes: entry.size || 0, allocatedBytes }) > 0) {
    log.warn('mirror skipped a file this volume cannot hold:', entry.relPath, 'needs', entry.size, 'bytes')
    return false
  }
  return true
}

export async function materializeOverlayFile(mount, share, entry, opts = {}) {
  const hashOf = opts.hashOf || overlayHashFile
  const verifyKey = entryRef(mount.shareId, entry.relPath)
  // Overlay content hashes are leaf/size-prefixed, NOT plain blake2b — compare
  // the on-disk copy with the overlay hasher, or the skip/adopt checks never
  // match and the mirror re-fetches every file every tick.
  const localRelPath = await state.resolveLocalRelPath(mount, entry.relPath, entry.contentHash, hashOf, opts.synced || state.syncedSetFor(mount), opts.fresh)
  const abs = pathFromMount(mount.mountPath, localRelPath)
  let onDisk = null
  // ENOENT is the only stat failure that means "nothing is there, the path is free to write".
  // Every other one means something IS there that we could not read — and the fetch below renames
  // over it regardless of whether we could stat it, since rename needs permission on the DIRECTORY,
  // not the file. Swallowing them all made the preserve step fail open in exactly the case it
  // exists for: an unreadable local file looked absent and was overwritten without a copy.
  let unreadable = false
  try {
    onDisk = await fs.promises.stat(abs)
  } catch (err) {
    if (err?.code !== 'ENOENT') {
      unreadable = true
      log.debug('could not stat a mirror path before materializing:', entry.relPath, '-', err.message)
    }
  }
  // Retained past the checks below: it is the evidence the ancestor comparison needs, and a pass
  // hashes a file at most once (foreign-mirror-rehash.test.js).
  let diskHash = null
  if (onDisk?.isFile() && entry.contentHash) {
    // Already-mirrored file: the verified record skips the full re-hash the poll
    // would otherwise run over every file each tick; only hash on a cache miss. No `expectLocal`
    // is needed: `abs` is the path resolveLocalRelPath just chose for these bytes, so a record
    // this mount wrote describes that same file.
    if (await isVerifiedUnchanged(mount.spaceId, verifyKey, entry.contentHash, entry.size, onDisk)) return 'present'
    try {
      diskHash = await hashOf(abs)
      if (diskHash === entry.contentHash) {
        // `onDisk` is the stat the hash above was taken against, so it fingerprints these bytes.
        await markVerified(mount.spaceId, verifyKey, entry.contentHash, { local: localRelPath, stat: onDisk })
        return 'present'
      }
    } catch (err) { log.debug('overlay hash skipped on disk:', err.message) }
  }
  const skip = fetchSkipReason(mount, entry, opts)
  if (skip) return skip
  // A manual download of the same file may already be in flight (mounted mid-download): fetching it
  // here too would interleave two producers on one decoration key and duplicate the bytes. A cheap
  // early-out so we do not queue for a slot to do it; the claim taken past the gate decides. Another
  // OWNER only — our own overlapping pass (a tick racing an adopted initial scan) is serialised by
  // activeOverlayFetches and must not be refused here (foreign-mirror-inflight.test.js).
  const claimedBy = fetchClaimedBy(transferIdFor(mount.spaceId, mount.shareId, entry.relPath))
  if (claimedBy && claimedBy !== FETCH_OWNER_MIRROR) return 'missing'
  // Below the claim check on purpose: charging a file the download engine already owns against our
  // own free space would refuse it over bytes that engine has already reserved.
  if (!(await mountCanTake(mount, entry, abs, opts.probe || createMountProbe(mount)))) return 'blocked'
  const streamKey = loopKey(mount.spaceId, mount.shareId)
  const releaseSlot = await acquireMirrorSlot(streamKey)
  try {
    // Fall back to the LIVE generation rather than undefined: loops.stopped compares against it,
    // so an absent gen would read as 'stopped' and refuse every fetch. A caller without one still
    // gets the check it needs — a stop landing during the wait above.
    return await fetchOverlayEntry(mount, share, entry, { abs, verifyKey, localRelPath, streamKey, gen: opts.gen ?? mirrorGen(streamKey), diskHash, localExists: !!onDisk || unreadable })
  } finally {
    releaseSlot()
  }
}

// Heartbeat while parked: a parked pass is in flight as far as pass-liveness is concerned, and a
// queue wait longer than the stall window would read as a wedge and be restarted. The wait is
// unbounded, so stamping progress either side of it is not enough. Never express: a background
// materialize must not outrank a click. Taken BEFORE the in-flight record, because
// cancelInflightFetch reads that record — a stop landing while parked would ask the vendor layer to
// cancel a fetch that never started, and tell the holder we paused a transfer we never began.
async function acquireMirrorSlot(streamKey) {
  loops.noteProgress(streamKey)
  const beat = setInterval(() => loops.noteProgress(streamKey), getResourceCaps().foreignPollIntervalMs)
  beat.unref?.()
  try {
    return await acquireFetchSlot({ express: false, owner: FETCH_OWNER_MIRROR })
  } finally {
    clearInterval(beat)
    loops.noteProgress(streamKey)
  }
}

// The gated half of a materialize: everything past the slot owns a chunk scheduler, a watchdog,
// an fd and a ticker.
async function fetchOverlayEntry(mount, share, entry, { abs, verifyKey, localRelPath, streamKey, gen, diskHash = null, localExists = false }) {
  // The wait for a slot is unbounded, so re-check the stop the catalog walk tests at every entry.
  if (mirrorStopped(streamKey, gen)) return 'missing'
  // Deliberately NOT re-checking reachability here, unlike the download engine past its own slot
  // wait: this function is reached from materializeCatalogFile, which callers drive one entry at a
  // time against mounts whose owner is unreachable by construction. The window it would close — the
  // owner leaving while this entry is parked on the shared slot — is already bounded, because the
  // fetch then returns 'no-peers' and ends the whole pass. One peer wait, once, not a spin.
  // Read AFTER the wait, not before it: the overlay can be torn down while a pass is parked.
  const overlay = getOverlay()
  if (!overlay) return 'missing'
  await fs.promises.mkdir(path.dirname(abs), { recursive: true })
  // Mirror download bar with speed/ETA.
  const total = entry.size || 0
  const decoKey = shareDecoKey(mount.shareId, entry.relPath)
  // Taken past the gate, not before it: holding it while queued would make the engine attach to a
  // fetch that has not started. Whoever holds it owns the decoration key until they release.
  const transferId = transferIdFor(mount.spaceId, mount.shareId, entry.relPath)
  const releaseClaim = claimFetch(transferId, FETCH_OWNER_MIRROR)
  if (!releaseClaim) return 'missing'
  let res
  let attempted = false
  let diag = null
  // Everything from here is inside the try, so no throw between the claim and the fetch can leak it.
  try {
    // Move a local edit aside before the fetch renames over it — here, past the gate, rather than
    // in the caller: every early-out above (a claim the engine holds, a stop landing during the
    // unbounded slot wait, the overlay torn down) would otherwise have moved the user's file and
    // then not replaced it, leaving the canonical path empty until a later tick.
    if (localExists) {
      try { await preserveLocalEdit(mount, entry, verifyKey, diskHash, abs, localRelPath) } catch { return 'missing' }
    }
    activeOverlayFetches.set(streamKey, { contentHash: entry.contentHash, relPath: entry.relPath, transferId })
    pausedHolders.supersede(streamKey)
    // The row just flipped to 'downloading' (foreignFetchActive) — poke the list re-derive.
    getIpc()?.emit('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
    // The overlay scheduler reports CUMULATIVE bytes; the ticker diffs them into speed/ETA.
    ;({ res, attempted, diag } = await runOverlayFetch(overlay, entry.contentHash, {
      label: 'overlay mirror',
      relPath: entry.relPath,
      size: total,
      destPath: abs,
      onProgress: ({ bytes, speed, eta }) => getIpc()?.emit('event:decoration', {
        channel: 'transfer', spaceId: mount.spaceId, key: decoKey, bytes, total, speed, eta,
      }),
      onVerify: (fraction) => getIpc()?.emit('event:decoration', {
        channel: 'transfer', spaceId: mount.spaceId, key: decoKey, phase: 'verifying', verifyFraction: fraction, bytes: 0, total,
      }),
      onTick: () => loops.noteProgress(streamKey),
    }))
  } catch (err) {
    // The diag rides the rejection, and annotating a rejection is best-effort (runOverlayFetch says
    // why) — so it can be absent. Dereferencing it blind would replace a real fault, an ENOSPC that
    // must pause the mount included, with a TypeError out of this handler.
    const failed = err?.diag ?? null
    // ECANCELLED is a deliberate pause/unmount abort (stopForeignLoop), not a
    // give-up: log it as a stop and keep whatever partial cancelFetch chose to keep.
    if (err?.code === 'ECANCELLED') { failed?.finish('paused'); return 'missing' }
    await handleOverlayMirrorFetchError(mount, share, entry, err, failed)
    return 'missing'
  } finally {
    activeOverlayFetches.delete(streamKey)
    releaseClaim()
    // Every settle (done/miss/error/pause) re-derives the row off the now-cleared fetch slot and
    // terminally clears the row's decoration. No probe: the claim above means no other producer
    // could have taken the key while we held it, so the decoration is ours to clear.
    getIpc()?.emit('event:share-files-updated', { spaceId: mount.spaceId, shareId: mount.shareId })
    getIpc()?.emit('event:decoration', { channel: 'transfer', spaceId: mount.spaceId, key: decoKey, done: true })
  }
  // null = nothing fetched: a stall after a holder was asked is a give-up (WARN);
  // never reaching a holder is a benign retry-next-tick (debug).
  if (!res) {
    const miss = classifyMiss({ attempted })
    diag.finish(miss)
    // 'no-holder' means the overlay had zero peers, which is a process-global fact rather than a
    // property of this file: every remaining entry would pay the same peer wait for the same
    // answer. 'failed' IS per-file — a holder was asked and died — so the walk must carry on.
    return miss === 'no-holder' ? 'no-peers' : 'missing'
  }
  diag.finish('done')
  // a local hit returns the source path without writing abs — copy the bytes by
  // path (never buffering a possibly multi-GB file in memory).
  if (res.local && res.destPath !== abs) {
    try { fs.copyFileSync(res.destPath, abs) } catch (err) { log.debug('overlay mirror local-copy failed:', entry.relPath, '-', err.message); return 'missing' }
  }
  // The transfer verified the content hash on landing — record it so the row can
  // surface a "verified" indicator without re-hashing. Stat the file we just landed, so the record
  // fingerprints the bytes the transfer proved; a stat we cannot take costs the record its
  // fingerprint, never its hash.
  let landed = null
  try {
    landed = await fs.promises.stat(abs)
  } catch (err) {
    log.debug('could not fingerprint a landed mirror file:', entry.relPath, '-', err.message)
  }
  await markVerified(mount.spaceId, verifyKey, entry.contentHash, { local: localRelPath, stat: landed })
  attempts.succeed(loopKey(mount.spaceId, mount.shareId), entry.relPath, entry.contentHash)
  return 'present'
}

// Abort the file this mount is fetching right now. discardPartial:false (pause) keeps the partial
// + journal so the next tick resumes; true (unmount) unlinks it. cancelFetch also tells the holder
// we paused/stopped, so its "who is downloading" indicator clears now rather than on the idle
// sweep. A pause releases the fetch slot while the holder still shows us paused, so the hash is
// remembered and a later unmount with no live fetch tells the holder we stopped.
export function cancelInflightFetch(key, discardPartial) {
  const inflight = activeOverlayFetches.get(key)
  if (inflight) {
    try { getOverlay()?.cancelFetch(inflight.contentHash, { discardPartial }) } catch {}
    activeOverlayFetches.delete(key)
    // A cancelled pass may never settle at all — a wedged fetch is exactly what restartForeignLoop
    // exists to recover — so the claim cannot wait for its finally, or the restart is refused by
    // the dead claim of the pass it just gave up on.
    dropFetchClaim(inflight.transferId)
    if (discardPartial) pausedHolders.supersede(key)
    else pausedHolders.remember(key, inflight.contentHash)
  } else if (discardPartial) {
    pausedHolders.stop(key)
  }
}

// Subsystem teardown: the markers left with holders, the integrity ledger and the attempt budget
// all die with the process that made the claims.
export function resetMirrorFetch() {
  pausedHolders.clear()
  integritySeen.clear()
  attempts.clear()
}

// A mount is gone for good — forget what we learned about its files. Not called on pause or on a
// health restart: those re-run, and re-arming there would re-record the same mismatch every resume.
export function forgetMirrorFetch(key) {
  integritySeen.forget(key)
  attempts.forget(key)
}
