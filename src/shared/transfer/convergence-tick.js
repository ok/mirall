// The slow level-triggered re-drive: one global pass that re-sends identity frames whose implicit
// ack never arrived, re-folds rosters whose considered records haven't replicated, re-pokes listings
// that gave up on a peer catalog, and rescues transfers whose owner the swarm has quietly stopped
// dialing. It is the standing answer to "restart the app and it fixes itself" — every arm here
// exists because some state used to need a restart to converge.
//
// A converged, quiet swarm does no work in this module at all: each arm is gated on an observable
// deficit, and the escalation to a discovery refresh is throttled and budgeted per space on top.
import { getSpace } from '../spaces/space.js'
import { getConvergenceConfig } from '../core/runtime-config.js'
import { escalationDue, announceStatus } from './announce-ledger.js'
import { refreshContentDiscoveries, contentPlaneHasPeer, getContentPlaneStatus } from './content-swarm.js'
import { takeIncompleteListSpaces } from './list-deficits.js'
import { rosterDeficits, recomputeMemberView, scheduleCapture, captureDeficits } from '../spaces/member-registry.js'
import { isSpaceLeaving } from './leave-protocol.js'
import { connectedPeers, socketToPeers, spaceTopics, spaceDiscoveries, socketMsgHandlers, announceLedger } from './swarm-registries.js'

let log = null
let sendSingleHandshake = null
// The stalled-owner probe stays a swarm.js slot filled from the Swarm subsystem's constructor deps;
// this reads it at call time. LIFECYCLE-3d retired the set*Hook seam — a nullable slot with a
// setter is a silent no-op when nobody sets it — and hook-deps.test.js holds that line by name.
let getStalledOwners = () => null
// Read at call time, not captured: initSwarm and destroySwarm reassign both handles.
let getSwarm = () => null
let getIpc = () => null

export function initConvergenceTick(deps) {
  log = deps.log
  sendSingleHandshake = deps.sendSingleHandshake
  getStalledOwners = deps.getStalledOwners
  getSwarm = deps.getSwarm
  getIpc = deps.getIpc
}

let convergenceTimer = null
let convergenceTicking = false          // re-entrancy guard: the tick is async, setInterval isn't
const deficitTicks = new Map()          // spaceId → consecutive ticks with a roster deficit
const lastRefreshAt = new Map()         // spaceId → last escalation (discovery.refresh) time
const escalationsSpent = new Map()      // spaceId → discovery.refreshes spent on the current deficit

// Re-send identity frames whose implicit ack never arrived. Settled means: for a member
// space, some identity on that socket is admitted to it (their reciprocal proved the round
// trip); for a pending space, the grant/deny flipped the status. A space that is leaving,
// left, or only held as a pending-leave replay topic (no record) has nothing to announce.
async function drainAnnounceLedger() {
  if (socketMsgHandlers.size === 0) return
  // Resolve per-space status only for the spaces actually in the ledger — a converged client
  // with an empty ledger does no bee reads at all.
  const pending = announceLedger.spaceIds()
  if (pending.size === 0) return
  const cfg = getConvergenceConfig()
  const status = new Map()
  for (const spaceId of pending) {
    if (!spaceTopics.has(spaceId) || isSpaceLeaving(spaceId)) continue
    // announceStatus distinguishes "present but statusless" (owner-created / v1 → 'active',
    // a real member space) from "gone" (null → settled). Conflating them killed the owner's heal.
    status.set(spaceId, announceStatus(await getSpace(spaceId)))
  }
  const isSettled = (socket, spaceId, kind) => {
    const st = status.get(spaceId)
    if (!st) return true
    if (kind === 'request') return st !== 'pending'
    for (const k of socketToPeers.get(socket) || []) {
      if (connectedPeers.get(k)?.spaces.has(spaceId)) return true
    }
    return false
  }
  const due = announceLedger.due({
    now: Date.now(),
    baseMs: cfg.announceBaseMs,
    capMs: cfg.announceCapMs,
    maxAttempts: cfg.announceMaxAttempts,
    isSettled,
  })
  for (const { socketId: socket, spaceId } of due) {
    const handler = socketMsgHandlers.get(socket)
    const topic = spaceTopics.get(spaceId)
    // A dead socket (disconnected during a prior await) leaves zombie ledger entries the pure
    // due() can't see socketMsgHandlers to prune — forget it here so its bucket evaporates.
    if (!handler) { announceLedger.forgetSocket(socket); continue }
    if (!topic) continue
    log.debug('re-announcing space', spaceId)
    await sendSingleHandshake(socket, handler, spaceId, topic)
  }
}

// One slow, global, deficit-gated pass — the level-triggered re-drive an app restart used
// to be: re-send unacked identity frames, re-fold rosters whose considered records haven't
// replicated (escalating a persistent deficit to a throttled discovery refresh — fresh
// connections mean fresh replication streams), and re-poke listings that gave up on a peer
// catalog under the read budget. A converged, quiet swarm does nothing here.
async function runConvergenceTick() {
  await drainAnnounceLedger()
  const cfg = getConvergenceConfig()
  const deficits = rosterDeficits()
  for (const spaceId of spaceTopics.keys()) {
    if (!deficits.has(spaceId) || isSpaceLeaving(spaceId)) {
      // Deficit cleared: reset all per-space escalation state so a LATER deficit (a new member
      // not yet replicated) gets a fresh escalation budget.
      forgetSpaceConvergence(spaceId)
      continue
    }
    const ticks = (deficitTicks.get(spaceId) || 0) + 1
    deficitTicks.set(spaceId, ticks)
    recomputeMemberView(spaceId)
    const spent = escalationsSpent.get(spaceId) || 0
    const due = spent < cfg.convergenceMaxEscalations && escalationDue({
      ticks,
      escalateTicks: cfg.convergenceEscalateTicks,
      lastRefreshAt: lastRefreshAt.get(spaceId) || 0,
      minMs: cfg.convergenceRefreshMinMs,
      now: Date.now(),
    })
    if (due) {
      lastRefreshAt.set(spaceId, Date.now())
      escalationsSpent.set(spaceId, spent + 1)
      log.info('convergence refresh — roster deficit persisted', ticks, 'ticks for', spaceId)
      const discovery = spaceDiscoveries.get(spaceId)
      if (discovery) {
        try {
          discovery.refresh({ client: true, server: true }).catch((err) => log.debug('convergence refresh failed:', spaceId, err.message))
        } catch (err) {
          log.debug('convergence refresh failed:', spaceId, err.message)
        }
      }
    }
  }
  for (const spaceId of takeIncompleteListSpaces()) {
    if (spaceTopics.has(spaceId) && !isSpaceLeaving(spaceId)) getIpc()?.emit('event:files-updated', { spaceId })
  }
  // Re-attempt incomplete peer-bee captures: a capture that raced a starved or
  // short-lived session heals here on a later one. Throttled per key inside the
  // scheduler; retired keys (complete or past the sweep cap) never come back.
  for (const key of await captureDeficits()) scheduleCapture(key)
  try { await rescueStalledTransfers() } catch (err) { log.debug('stalled-transfer rescue failed:', err.message) }
}

// The tick's cleanup only visits current spaceTopics, so a space we just left would dangle here
// (and mistime escalation on a same-space rejoin) — leaveSpaceTopic calls this on the way out.
export function forgetSpaceConvergence(spaceId) {
  deficitTicks.delete(spaceId)
  lastRefreshAt.delete(spaceId)
  escalationsSpent.delete(spaceId)
}

// Hyperswarm stops re-dialing a peer whose connections keep dying young: a link that drops inside
// its prove-yourself window never resets the peer's attempt counter, and after the fourth such
// close the peer loses its retry timer altogether — the next automatic dial is a topic re-lookup
// ten minutes out. The escalation above cannot save us: it is gated on a ROSTER deficit, and a
// two-peer space whose roster is fully replicated never has one, so a download can sit dead while
// the swarm believes it is converged.
//
// A pending download whose owner we hold no socket for is exactly that state, and a discovery
// refresh is the one lever that clears it (rediscovering a peer resets its attempts). Both planes
// need it: the bulk plane carries the bytes, but the control plane carries the presence lease the
// download's resume gate reads — rescuing only one leaves the transfer gated behind the other.
// Refresh eagerly at first — a flapping link brings the peer back within a second or two, and every
// cycle we sit out is a cycle the transfer makes no progress. But an owner who is simply offline
// would then have us re-announce forever, so each fruitless attempt backs the next one off, up to a
// quiet ceiling. Any attempt that finds every owner reachable resets it.
const STALL_RESCUE_MIN_MS = 10_000
const STALL_RESCUE_MAX_MS = 300_000
let lastStallRescueAt = 0
let stallRescueBackoffMs = STALL_RESCUE_MIN_MS
let stallRescueInFlight = false

export async function rescueStalledTransfers() {
  const stalledOwners = getStalledOwners()
  if (!getSwarm() || !stalledOwners || stallRescueInFlight) return false

  stallRescueInFlight = true
  try {
    const contentActive = getContentPlaneStatus().active
    let controlDown = false
    let contentDown = false
    for (const ownerKey of await stalledOwners()) {
      if (!connectedPeers.has(ownerKey)) controlDown = true
      if (contentActive && !contentPlaneHasPeer(ownerKey)) contentDown = true
    }
    if (!controlDown && !contentDown) {
      stallRescueBackoffMs = STALL_RESCUE_MIN_MS // everyone we are waiting on is reachable
      return false
    }
    if (Date.now() - lastStallRescueAt < stallRescueBackoffMs) return false

    lastStallRescueAt = Date.now()
    stallRescueBackoffMs = Math.min(stallRescueBackoffMs * 2, STALL_RESCUE_MAX_MS)
    log.info('stalled transfer — refreshing discovery:', controlDown ? 'control' : '', contentDown ? 'content' : '')
    if (controlDown) {
      for (const [spaceId, discovery] of spaceDiscoveries) {
        try { await discovery.refresh({ client: true, server: true }) } catch (err) { log.debug('stall refresh failed for', spaceId, err.message) }
      }
    }
    if (contentDown) await refreshContentDiscoveries()
    return true
  } finally {
    stallRescueInFlight = false
  }
}

export function startConvergenceTick() {
  if (convergenceTimer) return
  const { convergenceTickMs } = getConvergenceConfig()
  if (!convergenceTickMs) return
  convergenceTimer = setInterval(() => {
    // The tick is async and setInterval doesn't await it — skip a fire that lands while the
    // previous run is still in flight, so overlapping runs can't double-send or double-count.
    if (convergenceTicking) return
    convergenceTicking = true
    runConvergenceTick()
      .catch((err) => log.debug('convergence tick failed:', err.message))
      .finally(() => { convergenceTicking = false })
  }, convergenceTickMs)
  convergenceTimer.unref?.()
}

// What destroySwarm calls: stop the timer and drop every counter, so a restarted swarm escalates
// from a clean budget rather than inheriting the previous session's spent attempts.
export function resetConvergenceTick() {
  if (convergenceTimer) {
    clearInterval(convergenceTimer)
    convergenceTimer = null
  }
  convergenceTicking = false
  deficitTicks.clear()
  lastRefreshAt.clear()
  escalationsSpent.clear()
  lastStallRescueAt = 0
  stallRescueBackoffMs = STALL_RESCUE_MIN_MS
  stallRescueInFlight = false
}
