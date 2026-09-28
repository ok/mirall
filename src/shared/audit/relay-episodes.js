// Folds how a person is reached into one row per relayed stretch, plus one when the stretch ends on
// a direct connection. The unit is the PERSON, folded as members:reach folds it
// (network/member-reach.js): relayed while any socket that carries them is relayed. A stretch opens
// once one of their sockets has held a relay for the dwell, since hyperdht upgrades most pairings
// within seconds. It closes once the person reads direct a dwell after a path edge, so the
// registries have settled and a re-dial over the same relay reads as the same stretch.
//
// A stretch outlives a disconnect: nothing is written while the person is away, and the stretch
// closes when they are back directly, or continues when they are back through a relay. So the
// newest path row always agrees with the roster once both have settled. Nothing persists, because
// every socket is new after a restart.
import { createEpisodeCap } from './episode-cap.js'

export const KIND_PEER_RELAYED = 'network.peer_relayed'
/** @internal */
export const KIND_PEER_DIRECT = 'network.peer_direct'
const RELAY_CAP = 12
const RELAY_CAP_WINDOW_MS = 86400000
// A person who never comes back would otherwise pin their stretch forever. The cost of forgetting
// is no "connected directly again" row for a return after a week, which is the right thing to lose.
const RELAY_STALE_MS = 604800000

export function createRelayEpisodeTracker({
  dwellMs,
  cap = RELAY_CAP,
  capWindowMs = RELAY_CAP_WINDOW_MS,
  staleMs = RELAY_STALE_MS,
}) {
  // personKey → { info, leftAt, checkAt }: `leftAt` is when the person stopped reading relayed,
  // `checkAt` when their path is read next.
  const episodes = new Map()
  const admission = createEpisodeCap({ cap, windowMs: capWindowMs })

  // One of the person's sockets has held its relayed path for the dwell. `info` is
  // describeConnection's snapshot.
  function relayed(info, now) {
    const open = episodes.get(info.personKey)
    if (open) {
      open.leftAt = null
      open.checkAt = null
      return null
    }
    const verdict = admission.admit(info.personKey, now)
    if (verdict === 'suppress-first') return { suppressed: true, kind: KIND_PEER_RELAYED, info, cap, windowMs: capWindowMs }
    if (verdict !== 'record') return null
    episodes.set(info.personKey, { info, leftAt: null, checkAt: null })
    return { kind: KIND_PEER_RELAYED, info }
  }

  function schedule(personKey, open, reachOf, now) {
    if (open.leftAt === null && reachOf(personKey) !== 'relayed') open.leftAt = now
    if (open.checkAt === null) open.checkAt = now + dwellMs
  }

  // A socket left its relay: hyperdht moved it direct, or it closed. `personKey` is null when the
  // edge could not name its person, and then every open stretch is read again.
  function left(personKey, reachOf, now) {
    if (personKey === null) {
      for (const [key, open] of episodes) schedule(key, open, reachOf, now)
      return
    }
    const open = episodes.get(personKey)
    if (open) schedule(personKey, open, reachOf, now)
  }

  // The person connected again. Only a stretch they left needs reading.
  function returned(personKey, now) {
    const open = episodes.get(personKey)
    if (open && open.leftAt !== null && open.checkAt === null) open.checkAt = now + dwellMs
  }

  function forget(now) {
    for (const [personKey, open] of episodes) {
      if (open.checkAt === null && open.leftAt !== null && now - open.leftAt > staleMs) episodes.delete(personKey)
    }
  }

  // `reachOf(personKey)` is the person's path as of now: 'relayed', 'direct' or null.
  function step(now, reachOf) {
    admission.forget(now)
    forget(now)
    const rows = []
    for (const [personKey, open] of episodes) {
      if (open.checkAt === null || now < open.checkAt) continue
      open.checkAt = null
      const reach = reachOf(personKey)
      if (reach === 'relayed') {
        open.leftAt = null
        continue
      }
      if (reach !== 'direct') continue
      episodes.delete(personKey)
      const endedAt = open.leftAt ?? now
      rows.push({ kind: KIND_PEER_DIRECT, info: open.info, subject: { relayedMs: Math.max(0, endedAt - open.info.since) } })
    }
    return { rows, waitMs: waitMs(now) }
  }

  function waitMs(now) {
    let next = null
    for (const open of episodes.values()) {
      if (open.checkAt !== null) next = next === null ? open.checkAt : Math.min(next, open.checkAt)
    }
    return next === null ? null : Math.max(0, next - now)
  }

  // The log refused a row this tracker returned: the stretch it would have opened goes, so no lone
  // direct row can close it later, and the refusal does not count against the cap.
  function refused(personKey) {
    episodes.delete(personKey)
    admission.refund(personKey)
  }

  return {
    relayed,
    left,
    returned,
    step,
    waitMs,
    refused,
    reset: () => { episodes.clear(); admission.reset() },
    size: () => episodes.size,
  }
}
