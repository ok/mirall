// The worker's mount runtime: everything that keeps owned and mirrored folder mounts alive
// between boot and shutdown — the durable status writer, the per-share periodic reconcile
// timers, the resume passes for both mount kinds, and the probe that notices a mount point or a
// download root appearing or disappearing.
//
// It was ~250 lines of module-level state and top-level statements in the worker entry, which is
// why nothing could stop it: `periodicTimers` had a per-share cancel but no bulk one, and the
// probe interval was armed at the top level. As a Subsystem the maps are instance state, the
// probe rides `this.timers`, and _close is the bulk stop.
import fs from 'bare-fs'
import { Subsystem } from '../shared/core/subsystem.js'
import { getDeepReconcileEvery } from '../shared/core/runtime-config.js'
import { listDownloadRoots } from '../shared/core/paths.js'
import { AppError, ErrorCodes, classifyLocalIoFault } from '../shared/core/errors.js'
import { setOwnedMountStatus, setOwnedIndexPaused, patchOwnedMount, listOwnedMounts, listAllMounts, listForeignMounts, getOwnedMount, getForeignMount } from '../shared/folders/mount-store.js'
import { periodicReconcile, stopOwnedFolder, cancelIndex, mountRootAvailable } from '../shared/folders/owned-folders.js'
import { startForeignLoop, initialMaterializeScan, resumeAutoPausedForeignMount, autoPauseForeignMountGone, mirrorHealth, restartForeignLoop } from '../shared/folders/foreign-folders.js'
import { ensureMirror } from '../shared/folders/mirror-records.js'

const RECONCILE_INTERVAL_MS = 6 * 60 * 60 * 1000
const MOUNT_PROBE_INTERVAL_MS = 60_000
// Two consecutive bad probes before acting, so one slow sample cannot restart a working mirror.
const MIRROR_BAD_PROBES = 2
const MIRROR_MAX_RESTARTS = 3


// The download-root twin of owned-folders' mountRootAvailable, deliberately kept separate: a
// download root is not a mount, and borrowing the mount-named helper would imply it is.
function rootAvailable(root) {
  try { return fs.statSync(root).isDirectory() } catch { return false }
}

function readUnavailableRoots() {
  return listDownloadRoots().filter((root) => !rootAvailable(root))
}

// A classified fault gets its own durable status where one exists, so the folder screen can name
// the remedy instead of putting an errno in front of the user.
// mount-status-vocabulary.test.js asserts every status written here is one the contract declares.
function ownedFaultStatus(code) {
  return code === ErrorCodes.TRANSFER_DISK_FULL ? 'paused-enospc' : 'paused-error'
}

function mirrorKey(spaceId, shareId) {
  return spaceId + '/' + shareId
}

function sameRootSet(a, b) {
  return a.length === b.length && a.every((root, i) => root === b[i])
}


export class MountsRuntime extends Subsystem {
  constructor(name, deps) {
    super(name, deps)
    this.require('ipc')
    this.periodicTimers = new Map()
    this.reconcileCounters = new Map()
    // role:shareId → last-known existence of the mount path. Seeded by the resume passes and
    // maintained by the probe loop; a transition is what drives every status event.
    this.lastMountPointStatus = new Map()
    this.unavailableRoots = []
    // spaceId/shareId → consecutive unhealthy probes, restarts spent, and whether the budget
    // running out has already been reported.
    this.mirrorBadProbes = new Map()
    this.mirrorRestarts = new Map()
    this.mirrorGaveUp = new Set()
  }

  async _open() {
    await this._resumeOwnedMounts()
    await this._resumeForeignMounts()
    this.timers.setInterval(() => {
      this.probeMountPoints().catch((err) => this.log.debug('mount probe failed:', err.message))
      try { this.probeDownloadRoots() } catch (err) { this.log.debug('download-root probe failed:', err.message) }
      this.probeMirrorLiveness().catch((err) => this.log.debug('mirror liveness probe failed:', err.message))
    }, MOUNT_PROBE_INTERVAL_MS)
  }

  // Restart a watcher and a reconcile timer for every owned mount whose source folder is still
  // there; record the ones that are not, so the probe reads their return as a gone→present edge.
  async _resumeOwnedMounts() {
    try {
      const mounts = await listOwnedMounts()
      for (const mount of mounts) {
        // Don't point a watcher at a path that isn't there. The mount-point probe
        // loop restarts the watcher + reconcile once the path comes back.
        if (!mountRootAvailable(mount.mountPath)) {
          this.log.warn('owned mount path missing at startup:', mount.mountPath)
          this.lastMountPointStatus.set('owned-folder:' + mount.shareId, false)
          await this.setOwnedStatus(mount.spaceId, mount.shareId, 'mount-point-gone')
          continue
        }
        this.lastMountPointStatus.set('owned-folder:' + mount.shareId, true)
        // The watcher starts even for a paused index: a paused INDEX is not a paused FOLDER. Edits
        // made during the pause are seen, declined by the publish channel, and re-derived from disk
        // by the resume scan — pausing must not silently lose changes.
        this.deps.ipc.emit('main-request', {
          command: 'owned-folder:start-watcher',
          args: { shareId: mount.shareId, mountPath: mount.mountPath, ignore: mount.ignore },
        })
        // The scan would decline itself anyway, but an interval that can never do work reads as a
        // bug later. Re-assert the status so a restart repaints the badge from the durable record.
        if (mount.indexPaused) {
          await this.setOwnedStatus(mount.spaceId, mount.shareId, 'paused')
          continue
        }
        this.settleScanStatus(periodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore), mount.spaceId, mount.shareId)
        this.schedulePeriodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore)
      }
    } catch (err) {
      this.log.warn('owned-folder watcher restart failed:', err.message)
    }
  }

  // The mirror half: backfill a participation record, resume what auto-paused, pause what is
  // gone at boot, and start a poll loop for the rest.
  async _resumeForeignMounts() {
    try {
      const mounts = await listForeignMounts()
      for (const mount of mounts) {
        // Seed the probe baseline (parity with owned mounts above) so a later mount-point return
        // registers as a gone→present transition and the probe can auto-resume mid-session.
        this.lastMountPointStatus.set('foreign-folder:' + mount.shareId, mountRootAvailable(mount.mountPath))
        // Backfill a participation record for a mount that predates this feature (or whose mount-time
        // publish failed): only the fresh-mount handler publishes, and setMirrorState can't create one,
        // so without this a restored mirror stays invisible to owners forever.
        await ensureMirror(mount.spaceId, mount.shareId, { state: mount.enabled === false ? 'paused' : 'syncing' })
          .catch((err) => this.log.debug('mirror record ensure at boot failed for', mount.shareId, '-', err.message))
        if (!mount.enabled) {
          // Auto-paused mirrors (mount-point-gone / enospc / perm) recover at boot if the
          // local target is back and the fault cleared; a user pause ('paused') stays paused.
          await resumeAutoPausedForeignMount(mount.spaceId, mount.shareId).catch((err) =>
            this.log.debug('foreign auto-resume at boot deferred for', mount.shareId, '-', err.message))
          continue
        }
        // Enabled but its local target is missing at boot — durably pause it now. The probe only
        // pauses on a mid-session gone TRANSITION, so without this a gone-at-boot mirror would keep
        // a stale durable 'active' all session (its poll loop even mkdir -p's the missing root).
        if (!mountRootAvailable(mount.mountPath)) {
          await autoPauseForeignMountGone(mount.spaceId, mount.shareId).catch((err) =>
            this.log.debug('foreign gone-at-boot pause failed for', mount.shareId, '-', err.message))
          continue
        }
        // Owner drive may not be replicated at boot — the polling loop tolerates this
        // and retries every 30 s. We start the loop unconditionally and best-effort the
        // initial scan; if it fails because the peer isn't online yet, the next tick
        // picks up once the owner connects.
        startForeignLoop(mount)
        initialMaterializeScan(mount).catch((err) => {
          this.log.debug('foreign mirror initial scan deferred for', mount.shareId, '-', err.message)
        })
      }
    } catch (err) {
      this.log.warn('foreign-folder restart failed:', err.message)
    }
  }

  // A mirror whose pass is in flight but no longer advancing is wedged: every later tick coalesces
  // onto the dead promise, so the folder stops syncing until the app restarts. Restart the loop
  // rather than the subsystem — ForeignMirrors._open only re-wires the module, it starts no loops.
  async probeMirrorLiveness() {
    // The base clears the interval on close, but this probe awaits a restart: a shutdown starting
    // mid-pass would otherwise re-arm a loop stopAllForeignLoops just stopped.
    if (this.stopping) return
    const rows = mirrorHealth()
    const live = new Set(rows.map((row) => mirrorKey(row.spaceId, row.shareId)))
    for (const key of this.mirrorBadProbes.keys()) if (!live.has(key)) this.mirrorBadProbes.delete(key)
    for (const key of this.mirrorRestarts.keys()) if (!live.has(key)) this.mirrorRestarts.delete(key)
    for (const key of this.mirrorGaveUp) if (!live.has(key)) this.mirrorGaveUp.delete(key)

    for (const row of rows) {
      const key = mirrorKey(row.spaceId, row.shareId)
      if (row.ok) { this.mirrorBadProbes.delete(key); continue }

      const bad = (this.mirrorBadProbes.get(key) || 0) + 1
      this.mirrorBadProbes.set(key, bad)
      if (bad < MIRROR_BAD_PROBES) continue

      const spent = this.mirrorRestarts.get(key) || 0
      if (spent >= MIRROR_MAX_RESTARTS) {
        if (!this.mirrorGaveUp.has(key)) {
          this.mirrorGaveUp.add(key)
          this.log.error('mirror still wedged after', MIRROR_MAX_RESTARTS, 'restarts — leaving it down:', row.shareId, '-', row.detail)
        }
        continue
      }

      if (this.stopping) return
      this.mirrorRestarts.set(key, spent + 1)
      this.mirrorBadProbes.delete(key)
      this.log.warn('mirror wedged, restarting its loop:', row.shareId, '-', row.detail)
      try {
        await restartForeignLoop(row.spaceId, row.shareId)
      } catch (err) {
        this.log.warn('mirror loop restart failed:', row.shareId, '-', err.message)
      }
    }
  }

  // The bulk stop the per-share cancelPeriodicReconcile never had a caller for. The probe
  // interval rides this.timers, so the base clears it.
  async _close() {
    for (const timer of this.periodicTimers.values()) this.timers.clear(timer)
    this.periodicTimers.clear()
    this.reconcileCounters.clear()
  }


  // Persist + announce an owned mount's status in one step. The durable field is what a
  // boot or refresh re-derives the badge from — a transient-only event vanishes on reload —
  // and the event stays as the live decoration.
  async setOwnedStatus(spaceId, shareId, status, error) {
    try { await setOwnedMountStatus(spaceId, shareId, status, error ?? null) } catch (err) {
      this.log.debug('owned mount status persist failed:', shareId, '-', err.message)
    }
    this.deps.ipc.emit('event:owned-folder-mount-status', { spaceId, shareId, status, ...(error ? { error } : {}) })
  }

  // Everything that must happen once an owned source folder is known to be missing, from whichever
  // signal noticed first: the mount-point probe, or a scan/reconcile that bailed on the absent root.
  // Recording the absence in `this.lastMountPointStatus` is what lets the probe read the RETURN as a
  // gone→present edge. Without it, a folder that vanished and came back inside a single 60s probe
  // window produced no transition at all — so no status event, and every derived-from-event UI
  // (the FolderView banner, the share card badge) stayed latched on "source missing" indefinitely.
  async handleOwnedMountGone(spaceId, shareId) {
    this.lastMountPointStatus.set('owned-folder:' + shareId, false)
    // Stop pointing a watcher at a dead path and stop reconciling. The published snapshot and the
    // mount config are left untouched — a missing root is ambiguous, never a delete.
    this.deps.ipc.emit('main-request', { command: 'owned-folder:stop-watcher', args: { shareId } })
    this.cancelPeriodicReconcile(spaceId, shareId)
    // A vanished root makes chokidar emit one unlink per file; every queued retire dies with it.
    stopOwnedFolder(spaceId, shareId)
    await this.setOwnedStatus(spaceId, shareId, 'mount-point-gone')
  }

  // Map a reconcile/scan outcome to the durable owned-mount status. A scan RESOLVES (not rejects)
  // with { skipped } when it couldn't run — a missing root or a content mode this build can't serve
  // — so treating any resolution as 'active' would durably record a healthy scan that never ran.
  // A pass that was CANCELLED (delete, relocate, leave, cancel-index) records nothing: whoever
  // cancelled it owns the status from here, and a late 'active' would race a delete's mount
  // removal back into a zombie record. Returns the settled result (null on failure) so callers can
  // gate their scan-completed emit.
  async settleScanStatus(promise, spaceId, shareId) {
    try {
      const result = await promise
      if (result?.cancelled) return result
      if (result?.skipped === 'mount-point-gone') await this.handleOwnedMountGone(spaceId, shareId)
      // A paused index is a decision, not a fault: it carries no lastError and must not reach the
      // paused-error branch below, which raises an error toast and an unhealthy badge.
      else if (result?.skipped === 'index-paused') await this.setOwnedStatus(spaceId, shareId, 'paused')
      else if (result?.skipped) await this.setOwnedStatus(spaceId, shareId, 'paused-error', result.skipped)
      // A pass whose items failed on a classified fault is not a healthy scan. The pass resolving
      // does not mean its files reached the catalog — publish failures are per item — and reading
      // that resolution as 'active' is what made a full disk invisible to the owner.
      else if (result?.faultCode) await this.setOwnedStatus(spaceId, shareId, ownedFaultStatus(result.faultCode), result.faultCode)
      else await this.setOwnedStatus(spaceId, shareId, 'active')
      return result
    } catch (err) {
      this.log.warn('owned reconcile failed for', shareId, '-', err.message)
      await this.recordScanFault(spaceId, shareId, err)
      return null
    }
  }

  // The whole-pass half of the same question: the walk's recursive readdir, the catalog read and
  // the batch flush all reject with an errno, and every one of them used to reach the user as a
  // raw message. An unclassified failure keeps its message — an unrecognised error with nothing to
  // say is worse than a raw one, and the renderer shows it as a generic reason either way.
  async recordScanFault(spaceId, shareId, err) {
    const code = classifyLocalIoFault(err)
    if (code) {
      await this.setOwnedStatus(spaceId, shareId, ownedFaultStatus(code), code)
      return
    }
    // A root that vanished mid-pass: the probe would notice within its interval anyway, but going
    // through the gone path now also records the absence the probe reads the RETURN against.
    if (err?.code === 'ENOENT') {
      const mount = await getOwnedMount(spaceId, shareId)
      if (mount && !mountRootAvailable(mount.mountPath)) {
        await this.handleOwnedMountGone(spaceId, shareId)
        return
      }
    }
    await this.setOwnedStatus(spaceId, shareId, 'paused-error', err.message)
  }

  schedulePeriodicReconcile(spaceId, shareId, mountPath, ignore) {
    const key = spaceId + ':' + shareId
    const existing = this.periodicTimers.get(key)
    if (existing) this.timers.clear(existing)
    // Through this.timers like every other timer the class arms: _close clears the map itself,
    // but the base is what guarantees nothing survives a close that ended some other way.
    const timer = this.timers.setInterval(() => {
      // Every Nth periodic pass runs deep (content-hash) to catch an in-place rewrite
      // that kept identical size+mtime; the rest are the fast stat-only diff.
      const n = (this.reconcileCounters.get(key) || 0) + 1
      this.reconcileCounters.set(key, n)
      const every = getDeepReconcileEvery()
      const deep = every > 0 && n % every === 0
      this.settleScanStatus(periodicReconcile(spaceId, shareId, mountPath, ignore, { deep }), spaceId, shareId)
    }, RECONCILE_INTERVAL_MS)
    this.periodicTimers.set(key, timer)
  }

  cancelPeriodicReconcile(spaceId, shareId) {
    const key = spaceId + ':' + shareId
    const timer = this.periodicTimers.get(key)
    if (timer) {
      this.timers.clear(timer)
      this.periodicTimers.delete(key)
    }
  }

  // Pause an owned folder's index: stop the burst, stop the cadence, record the intent durably.
  // Unlike cancel-index (the Stop), nothing resumes this but an explicit resume — that is the whole
  // difference between the two.
  async pauseIndex(spaceId, shareId) {
    const mount = await getOwnedMount(spaceId, shareId)
    if (!mount) throw new AppError(ErrorCodes.NOT_FOUND, 'Folder is not mounted on this device')
    // The flag first: an item enqueued between the cancel and the write must be declined by the
    // publish channel rather than published.
    await setOwnedIndexPaused(spaceId, shareId, true)
    const cancelled = cancelIndex(spaceId, shareId)
    this.cancelPeriodicReconcile(spaceId, shareId)
    // A missing source folder outranks the pause as a status — but the event must fire either way:
    // it is the only thing that tells the renderer to re-read the mount, so skipping it left the
    // paused banner unrendered and the folder looking like it had simply finished.
    const gone = !mountRootAvailable(mount.mountPath)
    await this.setOwnedStatus(spaceId, shareId, gone ? 'mount-point-gone' : 'paused')
    return { cancelled, paused: true, mountPointGone: gone }
  }

  // Everything that can fail happens BEFORE the flag is cleared, so a resume that cannot run leaves
  // the pause intact rather than destroying the intent and silently doing nothing. Clearing it
  // still precedes arming the scan, or that scan is declined by the gate resume has not yet lifted.
  async resumeIndex(spaceId, shareId) {
    const mount = await getOwnedMount(spaceId, shareId)
    if (!mount) throw new AppError(ErrorCodes.NOT_FOUND, 'Folder is not mounted on this device')
    if (!mountRootAvailable(mount.mountPath)) {
      await this.handleOwnedMountGone(spaceId, shareId)
      throw new AppError(ErrorCodes.NOT_FOUND, 'Source folder is missing — locate it before resuming')
    }
    await setOwnedIndexPaused(spaceId, shareId, false)
    // A relocate that landed while this was paused recorded a debt: its deep pass never ran, and
    // the fast diff would re-advertise every entry on the new tree's fresh mtimes.
    const deep = !!mount.deepScanOwed
    if (deep) await patchOwnedMount(spaceId, shareId, { deepScanOwed: false })
    // Before the pass, not after: on a large folder the walk is minutes, and a badge still reading
    // 'paused' makes the click look ignored.
    await this.setOwnedStatus(spaceId, shareId, 'scanning')
    this.settleScanStatus(periodicReconcile(spaceId, shareId, mount.mountPath, mount.ignore, { deep }), spaceId, shareId)
    this.schedulePeriodicReconcile(spaceId, shareId, mount.mountPath, mount.ignore)
    return { resumed: true, deep }
  }

  async probeMountPoints() {
    const fsMod = await import('bare-fs')
    const all = await listAllMounts()
    for (const mount of all) {
      const key = mount.role + ':' + mount.shareId
      let exists = true
      try { fsMod.default.statSync(mount.mountPath) } catch { exists = false }
      const prev = this.lastMountPointStatus.get(key)
      if (prev === exists) continue
      const wasGone = prev === false
      this.lastMountPointStatus.set(key, exists)

      if (mount.role === 'owned-folder') {
        if (!exists) {
          // Source folder just disappeared — same teardown the watcher-driven path runs.
          await this.handleOwnedMountGone(mount.spaceId, mount.shareId)
        } else if (wasGone) {
          // Source folder came back (USB replugged, network mount up, moved back). Resume: restart
          // the watcher, run one catch-up reconcile whose OUTCOME sets the durable status (so a
          // failing re-scan records paused-error, not a fabricated 'active'), and re-arm the timer.
          this.deps.ipc.emit('main-request', {
            command: 'owned-folder:start-watcher',
            args: { shareId: mount.shareId, mountPath: mount.mountPath, ignore: mount.ignore },
          })
          // A path coming back is not the user pressing Resume, so a paused index stays paused —
          // without this, unplug + replug is a silent resume. The status is re-asserted because
          // handleOwnedMountGone overwrote it when the path vanished.
          const paused = (await getOwnedMount(mount.spaceId, mount.shareId))?.indexPaused
          if (paused) {
            await this.setOwnedStatus(mount.spaceId, mount.shareId, 'paused')
            continue
          }
          this.settleScanStatus(periodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore), mount.spaceId, mount.shareId)
          this.schedulePeriodicReconcile(mount.spaceId, mount.shareId, mount.mountPath, mount.ignore)
        }
        // A plain present tick (neither branch — e.g. the first probe of a freshly-added mount) must
        // NOT assert durable 'active': status is owned by scan outcomes, and blanket-writing 'active'
        // here would clobber a real paused-error the mount scan just recorded.
      } else {
        if (!exists) {
          // The poll loop may be idle (no writes → no I/O error to classify), leaving a
          // stale durable 'active' that a refresh/boot would resurrect — persist the pause.
          await autoPauseForeignMountGone(mount.spaceId, mount.shareId).catch((err) =>
            this.log.debug('foreign auto-pause on gone path failed for', mount.shareId, '-', err.message))
        }
        if (exists && wasGone) {
          // Local target returned mid-session — resume an auto-paused mirror (owned-branch
          // parity). No-ops for a user pause or a still-faulted mount.
          await resumeAutoPausedForeignMount(mount.spaceId, mount.shareId).catch((err) =>
            this.log.warn('foreign auto-resume after mount return failed for', mount.shareId, '-', err.message))
        }
        // Report the mount's real status (a user pause / still-faulted mount stays paused),
        // not a fabricated 'active' derived from mere path presence.
        const current = exists ? await getForeignMount(mount.spaceId, mount.shareId) : null
        this.deps.ipc.emit('event:foreign-folder-mount-status', {
          spaceId: mount.spaceId,
          shareId: mount.shareId,
          status: current ? (current.status || 'active') : 'mount-point-gone',
        })
      }
    }
  }

  // === Download-root availability ===
  //
  // The mount probe above covers owned/mirrored folders; download roots had no equivalent, which
  // is why a deleted or ejected download folder only ever surfaced as a failing transfer. Every
  // root counts, not just the global one — a per-space override can vanish on its own.
  //
  // Level-triggered probe, edge-triggered emit: re-broadcasting an unchanged set every minute
  // would churn the renderer for nothing, so the event fires only when the set actually changes.
  // The renderer gets its INITIAL state from downloads:roots-status instead of waiting up to a
  // full interval for the first transition.
  probeDownloadRoots() {
    const next = readUnavailableRoots()
    if (sameRootSet(next, this.unavailableRoots)) return
    this.unavailableRoots = next
    if (next.length > 0) this.log.warn('download folder unavailable:', next.join(', '))
    else this.log.info('all download folders are available again')
    this.deps.ipc.emit('event:download-roots-status', { unavailable: next })
  }
}
