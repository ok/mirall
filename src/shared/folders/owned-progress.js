// What an owner is still adding, told to the renderer and to the share's members: one throttled
// frame per queue change, plus a re-announce timer for the long gaps between changes.
import { makeKeyedCoalescer } from '../core/coalesce.js'
import { liveHandle, ownedScheduler } from '../core/timers.js'
import { ownedKey } from './owned-policy.js'

// Members learn of a scan from frames sent when the queue changes SHAPE — and a queue sitting
// behind one multi-GB hash changes shape twice in several minutes. A member who opens the folder in
// between, or who reconnects mid-scan, would otherwise see nothing at all, which is exactly the case
// this feature exists for. So an active share re-announces itself on a timer: ephemeral status is
// re-announced, never replayed, and the frame is idempotent, so a missed one costs latency only.
export const INDEX_ANNOUNCE_MS = 5000

// `timers` is read lazily on every use: the owner of the set is the subsystem, and a _close that
// rejects never reaches its own teardown, so a handle held here can outlive the set that armed it.
export function createOwnedProgress({ timers, emit, broadcast, statusFor, announceMs = INDEX_ANNOUNCE_MS }) {
  const announcing = new Map()
  let announceTimer = null

  function announceIndex(spaceId, shareId) {
    const status = statusFor(spaceId, shareId)
    if (!(status?.adding > 0)) return false
    broadcast(spaceId, { shareId, adding: status.adding, bytesQueued: status.bytesQueued })
    return true
  }

  // Runs only while some share is scanning, and stops itself the moment none is.
  function armAnnounce() {
    const live = timers()
    // See startPresenceHeartbeat: a _close that rejects leaves this binding holding a handle its
    // set has already disarmed, and the guard below would read that as "already armed" forever.
    announceTimer = liveHandle(live, announceTimer)
    if (announceTimer || announcing.size === 0 || !live || live.closed) return
    announceTimer = live.setInterval(() => {
      for (const [key, at] of announcing) if (!announceIndex(at.spaceId, at.shareId)) announcing.delete(key)
      if (announcing.size === 0) stopAnnounce()
    }, announceMs)
  }

  function stopAnnounce() {
    if (announceTimer) timers()?.clear(announceTimer)
    announceTimer = null
    announcing.clear()
  }

  const throttled = makeKeyedCoalescer((spaceId, shareId) => {
    // The publish service drains its executors AFTER the owning subsystem closes, and each settling
    // item pokes progress on the way out. With no live timer set there is no window to hold open, so
    // every one of those pokes would fire on its own — turning one throttled frame per 500 ms into
    // one broadcast per drained item, at shutdown, into a swarm being torn down. Nobody is left to
    // act on index progress by then: the drain is silent.
    if (!timers()) return
    const status = statusFor(spaceId, shareId)
    if (!status) return
    emit('event:owned-folder-index-progress', { spaceId, shareId, ...status })
    // Members see the same queue we do. Only the two numbers a watcher can act on cross the wire —
    // the rest (tallies, ordering, concurrency) is ours and says nothing about their view.
    broadcast(spaceId, { shareId, adding: status.adding, bytesQueued: status.bytesQueued })
    const key = ownedKey(spaceId, shareId)
    if (status.adding > 0) { announcing.set(key, { spaceId, shareId }); armAnnounce() }
    else announcing.delete(key)
  }, {
    intervalMs: 500,
    keyOf: ownedKey,
    // The coalescer's trailing timer is the same long-lived handle as the announce one above, held
    // in the engine's own map; its only clear is reset(), which a _close that rejects never reaches.
    ...ownedScheduler(timers),
  })

  return {
    poke: (spaceId, shareId) => throttled.poke(spaceId, shareId),
    flush: (spaceId, shareId) => throttled.flush(spaceId, shareId),
    stopAnnounce,
    reset() {
      stopAnnounce()
      throttled.reset()
    },
  }
}
