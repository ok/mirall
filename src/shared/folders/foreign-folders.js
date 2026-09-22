// The mirror side of folder sharing: another member's share materialized read-only to a local
// mount path. A per-mount loop lists the owner's catalog and materializes the diff; deletions are
// honoured only for files the mirror itself wrote, and only while the owner is provably online.
//
// This module is the composition root: it constructs the loop engine and the per-mount state,
// hands them to the leaves below, subscribes the two level triggers and owns the subsystem's
// lifetime. The leaves never import it back.
import { onPeerOnline } from '../network/handshake-apply.js'
import { MAIN_REQUEST, MAIN_REQUEST_FRAME } from '../contract/main-requests.js'
import { getForeignPollIntervalMs } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'
import { Subsystem } from '../core/subsystem.js'
import { setOverlayCatalogChangeHook } from '../transfer/backends/overlay/folder-downloads.js'
import { drainFetchSlots, FETCH_OWNER_MIRROR } from '../transfer/backends/overlay/fetch-gate.js'
import { mirrorVerdict } from './mirror-policy.js'
import { createMirrorLoops } from './mirror-loop.js'
import { createMirrorState } from './mirror-state.js'
import { createPassWriters } from './pass-writer.js'
import { initMirrorSignals, resetMirrorSignals } from './mirror-signals.js'
import { initMirrorFetch, cancelInflightFetch, resetMirrorFetch } from './mirror-fetch.js'
import { initMirrorPass, materializeOnce, resetMirrorPass } from './mirror-pass.js'
import { initForeignPause } from './foreign-pause.js'
import { initForeignVerbs, stopForeignLoop, restartForeignLoop, setForeignEnabled } from './foreign-verbs.js'
import { maybeUnmountIfOwnerGone } from './foreign-orphan.js'

const log = createLogger('foreign-folders')

// The loop engine. Everything mount-specific stays here; the interval, the one-pass-at-a-time
// serialisation, the cancellation generation and the liveness heartbeat live in mirror-loop.js.
const loops = createMirrorLoops({
  intervalMs: () => getForeignPollIntervalMs(),
  runPass: ({ spaceId, shareId }) => materializeOnce(spaceId, shareId),
  onStop: (key, { discardPartial = false } = {}) => {
    cancelInflightFetch(key, discardPartial)
    state.forgetConverged(key)
  },
  onError: (err) => log.debug('materialize tick failed:', err.message),
})
const state = createMirrorState()
const passWriter = createPassWriters(loops)

let unsubscribePeerOnline = null

// A mirror is watched exactly while its loop is live. The watcher runs in Electron main, so
// arming it is a bus command; a worker without a main (a flow test) emits into nothing.
function mirrorWatch(ipc) {
  return {
    start: (mount) => ipc.emit(MAIN_REQUEST_FRAME, {
      command: MAIN_REQUEST.FOREIGN_FOLDER_START_WATCHER,
      args: { spaceId: mount.spaceId, shareId: mount.shareId, mountPath: mount.mountPath },
    }),
    stop: (spaceId, shareId) => ipc.emit(MAIN_REQUEST_FRAME, {
      command: MAIN_REQUEST.FOREIGN_FOLDER_STOP_WATCHER,
      args: { spaceId, shareId },
    }),
  }
}

/** @internal production starts the mirror through this file's own _open() */
export function initForeignFolders(_ipc) {
  initMirrorSignals(_ipc)
  initForeignVerbs({ loops, state, passWriter, watch: mirrorWatch(_ipc) })
  initForeignPause({ state, loops, stopForeignLoop, setForeignEnabled })
  initMirrorFetch({ state, loops, passWriter })
  initMirrorPass({ state, loops, passWriter, maybeUnmountIfOwnerGone })
  // Materialize promptly when an owner's catalog appends, instead of waiting for
  // the mirror's poll tick.
  setOverlayCatalogChangeHook(onPeerDriveChanged)
  // The other level trigger: a pass gated on an offline owner did nothing at all, so without this
  // an offline->online flip waits out a whole poll interval before the first byte moves.
  unsubscribePeerOnline?.()
  unsubscribePeerOnline = onPeerOnline(onOwnerOnline)
}

const APPEND_TICK_DEBOUNCE_MS = 250

// Both level triggers poke the same way — every mirror in the space, debounced. A loop record
// carries no ownerKey, and a mirror whose owner is uninvolved re-derives and settles for the price
// of a map lookup, so filtering by owner would buy nothing and cost a mount read per event.
function pokeSpaceMirrors(spaceId) {
  for (const loop of loops.entries()) {
    if (loop.spaceId !== spaceId) continue
    loops.debounce(loop.key, { spaceId: loop.spaceId, shareId: loop.shareId }, APPEND_TICK_DEBOUNCE_MS)
  }
}

// The owner's content changed. Run a materialize tick now (debounced) for each
// active mirror in that space instead of waiting for the 30s poll, so owner-side
// edits/deletes reflect on the mirror's disk as promptly as they do in the folder
// view.
/** @internal */
export function onPeerDriveChanged(spaceId) {
  pokeSpaceMirrors(spaceId)
}

// A member handshaked into this space. Any mirror of theirs has been skipping its passes on the
// reachability gate, so re-drive now rather than at the next tick — and walk, not trust the
// watermark: nothing repaired the folder while the owner was away, so a file deleted from it then is
// missing against a catalog that has not moved.
/** @internal */
export function onOwnerOnline(_ownerKey, spaceId) {
  for (const loop of loops.entries()) if (loop.spaceId === spaceId) state.forgetConverged(loop.key)
  pokeSpaceMirrors(spaceId)
}

// One verdict per mount with a live loop (loops.entries() says why the others are not reported).
/** @internal */
export function mirrorHealth({ now = Date.now() } = {}) {
  const pollIntervalMs = getForeignPollIntervalMs()
  return loops.entries().map((loop) => ({
    ...loop,
    ...mirrorVerdict(loops.liveness(loop.key), { now, pollIntervalMs }),
  }))
}

// discardPartial stays false — a shutdown is a pause, not an unmount: the partial and its journal
// are what let the next boot resume instead of refetching.
function stopAllForeignLoops({ settleMs = 5000 } = {}) {
  return loops.stopAll({ settleMs })
}

// Owns the mirror loops as a set: _open is the module's wiring, _close is the bulk stop.
export class ForeignMirrors extends Subsystem {
  constructor(name, deps) { super(name, deps); this.require('ipc'); this.units = new Map() }
  async _open() { initForeignFolders(this.deps.ipc) }
  // stopAllForeignLoops pauses rather than unmounts, so it is the one path that FILLS
  // pausedHolders. Without the clear the hashes outlive the subsystem that recorded them, and a
  // later open inherits markers for fetches belonging to a previous lifetime.
  // The scoped drain comes first: a pass parked on the shared fetch gate cannot observe the
  // generation bump stopAllForeignLoops relies on, and would hold the 1500 ms tier budget open
  // until the 5000 ms settle timeout. Scoped to FETCH_OWNER_MIRROR because OverlayBackend closes
  // AFTER us — an unscoped drain would release the two engines' backlog into an overlay that is
  // still live, and those tasks pass their own hasOverlay() guard.
  async _close() {
    unsubscribePeerOnline?.()
    unsubscribePeerOnline = null
    resetMirrorPass()
    drainFetchSlots(FETCH_OWNER_MIRROR)
    await stopAllForeignLoops()
    resetMirrorFetch()
    resetMirrorSignals()
  }

  // Counts, not identifiers: diagnostics:export is user-shareable and redacts peer keys and
  // topics, so space and share ids must not ride along. The probe names the mount in the worker
  // log instead.
  health() {
    const open = !this.closed && !this.stopping
    const mirrors = open ? mirrorHealth() : []
    const wedged = mirrors.filter((mirror) => !mirror.ok)
    return {
      ok: open && wedged.length === 0,
      detail: wedged.length ? wedged.map((mirror) => mirror.detail).join('; ') : null,
      mirrors: { total: mirrors.length, wedged: wedged.length },
    }
  }

  // One unit per mount with a live loop. The ids are remembered so recover() needs no key parsing —
  // a share id is opaque and splitting it would be a guess.
  supervise({ now = Date.now() } = {}) {
    if (this.closed || this.stopping) return []
    const rows = mirrorHealth({ now })
    this.units = new Map(rows.map((row) => [row.key, { spaceId: row.spaceId, shareId: row.shareId }]))
    return rows.map((row) => ({ key: row.key, ok: row.ok, detail: row.detail, label: row.shareId }))
  }

  async recover(key) {
    if (this.stopping) return
    const unit = this.units.get(key)
    if (!unit) return
    await restartForeignLoop(unit.spaceId, unit.shareId)
  }
}
