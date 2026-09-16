// The filesystem watcher's side of an owned folder: one event in, one interactive work item out,
// plus the trailing catch-up diff that covers what the watcher itself missed.
import path from 'bare-path'
import { MOUNT_STATUS } from '../contract/statuses.js'
import { createLogger } from '../core/logger.js'
import { ignorePathsFor } from './echo-guard.js'
import { getOwnedMount, findOwnedMountByShareId } from './mount-store.js'
import { relToDriveKey as relToKey, isAbsoluteDriveKey } from './path-keys.js'
import { statFacts } from './disk-presence.js'
import { OP, PRIORITY } from './work-item.js'
import { ownedKey } from './owned-policy.js'

const log = createLogger('owned-folders')

const POST_EVENT_RECONCILE_MS = 2000
// Backoff for a catch-up that deferred a still-settling file, so a log written for minutes costs a
// stat walk every minute, not every two seconds.
const CATCHUP_BACKOFF_MAX_MS = 60000

const catchupTimers = new Map()
// Catch-up passes in flight, and the latch that stops new ones being armed: a catch-up re-arms
// ITSELF while files are still settling, so clearing the timers alone leaves one to fire on a
// closed store.
const catchupInFlight = new Set()
let stopping = false

// Injected by owned-folders.js.
let timers = () => null
let scheduler = () => { throw new Error('owned-folders: not started') }
let runPassFor = async () => null
let settleScan = null
let emit = () => {}

export function initOwnedWatcher(d) {
  timers = d.timers
  scheduler = d.scheduler
  runPassFor = d.runPassFor
  settleScan = d.settleScan
  emit = d.emit
  stopping = false
}

// Chokidar can drop `add` events when several files land in a new subfolder at once (macOS
// fsevents coalescing). After watcher activity settles, one catch-up diff publishes stragglers.
// A pass that deferred a still-settling file re-arms itself (with backoff): the deferred file's
// own add may be the one that was dropped, and nothing else would publish it before the periodic
// pass. The mount is re-read for the re-arm, so a share deleted or relocated meanwhile is not
// chased with a stale path.
function scheduleCatchup(mount, delayMs = POST_EVENT_RECONCILE_MS) {
  const live = timers()
  if (stopping || !live) return
  const { spaceId, shareId } = mount
  const key = ownedKey(spaceId, shareId)
  live.clear(catchupTimers.get(key))
  const timer = live.setTimeout(() => {
    catchupTimers.delete(key)
    if (stopping) return
    const scan = runPassFor(mount, { deferFresh: true })
    // The pass is registered so the subsystem's close can WAIT for it: clearing the timer only
    // stops the next one, and a scan still walking the mount when the store closes reports
    // SESSION_CLOSED into a status write nobody asked for.
    catchupInFlight.add(scan)
    scan.finally(() => catchupInFlight.delete(scan)).catch(() => {})
    scan.then(async (r) => {
      if (stopping || !(r?.deferred > 0) || r.cancelled) return
      const current = await getOwnedMount(spaceId, shareId)
      if (current && !catchupTimers.has(key)) scheduleCatchup(current, Math.min(delayMs * 2, CATCHUP_BACKOFF_MAX_MS))
    }).catch(() => {})
    if (settleScan) settleScan(scan, spaceId, shareId)
    else scan.catch((err) => log.debug('catch-up reconcile failed:', err.message))
  }, delayMs)
  catchupTimers.set(key, timer)
}

function relToDriveKey(relPath) {
  return relToKey(relPath, path.sep)
}

export async function handleFsEventFromMain(event) {
  const mount = await findOwnedMountByShareId(event.shareId)
  if (!mount) {
    log.debug('fs event for unknown share', event.shareId)
    return
  }
  return await onFsEvent(mount.spaceId, event.shareId, event.action, event.relPath, event.absPath)
}

// Resolves once the event's work item has settled (or its rerun, when the item was already
// running), so a caller that awaits it observes the effect.
/** @internal */
export async function onFsEvent(spaceId, shareId, action, relPath, absPath) {
  const mount = await getOwnedMount(spaceId, shareId)
  if (!mount) {
    log.debug('fs event for unknown mount', spaceId, shareId)
    return
  }
  scheduleCatchup(mount)

  const driveRel = relToDriveKey(relPath)
  if (isAbsoluteDriveKey(driveRel)) {
    log.warn('refusing fs event with absolute key:', action, driveRel)
    return
  }
  const guard = ignorePathsFor(shareId)
  if (guard.has(absPath)) {
    guard.delete(absPath)
    return
  }

  const { size, mtime } = statFacts(absPath)
  const { settled } = scheduler().enqueue({
    spaceId, shareId, relPath: driveRel,
    op: action === 'unlink' ? OP.RETIRE : OP.PUBLISH,
    size, mtime, priority: PRIORITY.INTERACTIVE,
  })
  const outcome = await settled
  // The fast signal: the item's own settle says the root is gone now, while the durable status
  // only lands when the debounced catch-up pass settles, POST_EVENT_RECONCILE_MS later.
  if (outcome.result?.outcome === 'skipped-root-gone') {
    emit('event:owned-folder-mount-status', { spaceId, shareId, status: MOUNT_STATUS.MOUNT_POINT_GONE })
  }
  return outcome
}

// Tolerant of a closed timer set: this is a cleanup path that can legally run after one, and the
// set has already been emptied by then.
export function forgetCatchup(key) {
  timers()?.clear(catchupTimers.get(key))
  catchupTimers.delete(key)
}

export function stopWatcher() {
  stopping = true
  const live = timers()
  for (const timer of catchupTimers.values()) live?.clear(timer)
  catchupTimers.clear()
}

// Bounded, like every other drain: the pass itself bails at its next file, and waiting for that
// bail is what makes closing the cores it reads safe.
export async function drainCatchups({ settleMs = 3000 } = {}) {
  if (!catchupInFlight.size) return
  await Promise.race([
    Promise.allSettled([...catchupInFlight]),
    new Promise((resolve) => { const t = setTimeout(resolve, settleMs); t.unref?.() }),
  ])
}
