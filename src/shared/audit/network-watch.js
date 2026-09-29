// Wires the pure trackers into the data layer: owns the timers, writes the rows, advances the
// durable device state, and enforces the one rule no tracker can see on its own — a PEER row
// is only honest while OUR OWN connectivity is healthy. When this device is blocked every peer
// looks unreachable, and the device row already says why; writing "Anna went offline" for each of
// twenty members would blame twenty people for one pulled cable.
//
// The timers are not optional. Once the verdict is stable-blocked and the app is idle, swarm.js
// stops emitting status altogether (the liveness probe only emits when its failure COUNT changes),
// so "re-check on the next emit" would leave a held-down row unwritten forever.
import { createLogger } from '../core/logger.js'
import { record } from './audit-log.js'
import { getNetworkState, setNetworkState } from './audit-watch-state.js'
import { createEpisodeTracker, evidenceFor } from './connectivity-episodes.js'
import { createPeerPresenceTracker } from './presence-episodes.js'
import { createRelayEpisodeTracker, KIND_PEER_RELAYED } from './relay-episodes.js'
import { TARGET_KIND } from '../contract/audit-kinds.js'
import { truncateRelayKey } from '../contract/relay-key.js'
import { peerActor, spaceRef, systemActor, targetRef } from './audit-record.js'

const log = createLogger('network-watch')

let device = null
let peers = null
let relays = null
// The owning subsystem's timer set, handed in by initNetworkWatch. Both handles below re-arm
// themselves, so they outlive every call that arms them and nothing scoped to a call can clear
// them; owning them here means the AuditLog subsystem's close reaches them on every path,
// including a failed _open, which ReadyResource ends without ever running _close.
let timers = null
let deviceTimer = null
let peerTimer = null
let relayTimer = null
let relayDwellMs = 0
const relayTimers = new Map()
// How a person is reached, installed by the swarm's relay wiring and cleared with it: the network
// layer owns the registries this reads, and outlives an AuditLog restart.
let readReach = () => null

// Arming through a closed set THROWS, by design — a late continuation that still wants a timer is
// a bug worth seeing. Both re-arm tails run from a timer callback, where a throw would escape into
// the event loop, so they ask first rather than being surprised.
function canArm() { return !!timers && !timers.closed }
let emitUpdated = null
let session = null
let last = null
let degraded = false
let running = false
let pending = false

export function initNetworkWatch({ emit = null, sessionId = null, dwellMs = 0, peerDwellMs = 0, relayDwellMs: relayDwell = 0, timers: owner = null } = {}) {
  timers = owner
  relayDwellMs = relayDwell
  device = createEpisodeTracker(dwellMs ? { dwellMs } : {})
  peers = createPeerPresenceTracker(peerDwellMs ? { dwellMs: peerDwellMs } : {})
  relays = createRelayEpisodeTracker({ dwellMs: relayDwell })
  emitUpdated = emit
  // Distinguishes an outage that began in the run still going from one spanning a restart, which is
  // what makes the duration on a restored row honest — or, correctly, absent.
  session = sessionId || Date.now().toString(36)
  last = null
  degraded = false
}

export function resetNetworkWatch() {
  if (deviceTimer) { timers?.clear(deviceTimer); deviceTimer = null }
  if (peerTimer) { timers?.clear(peerTimer); peerTimer = null }
  if (relayTimer) { timers?.clear(relayTimer); relayTimer = null }
  for (const handle of relayTimers.values()) timers?.clear(handle)
  relayTimers.clear()
  device?.reset()
  peers?.reset()
  relays?.reset()
  last = null
  running = false
  pending = false
  degraded = false
}

// Called from swarm.js's status EMIT path — never from getSwarmStatus, which is a read and must not
// start timers that outlive destroySwarm.
export function observeReachability(observation) {
  if (!device) return
  last = observation
  const nowDegraded = observation.verdict !== 'healthy' && observation.verdict !== 'unknown'
  if (nowDegraded && !degraded) peers.abandon()
  if (observation.verdict !== 'unknown') degraded = nowDegraded
  void pumpDevice()
}

// The peer hooks sit in the handshake and disconnect hot paths, so they carry audit-log.js's
// contract: auditing must never fail, slow, or throw into the operation it describes.
function guarded(fn) {
  return (...args) => {
    try {
      return fn(...args)
    } catch (err) {
      log.warn('peer presence step failed:', err.message)
      return undefined
    }
  }
}

async function pumpDevice() {
  if (!device || !last) return
  if (running) { pending = true; return }
  running = true
  try {
    const persisted = await getNetworkState()
    const { row, next, waitMs } = device.step({ ...last, now: Date.now(), session, persisted })

    if (deviceTimer) { timers?.clear(deviceTimer); deviceTimer = null }
    if (waitMs != null && canArm()) {
      deviceTimer = timers.setTimeout(() => { deviceTimer = null; void pumpDevice() }, waitMs + 50)
    }
    if (!row) return

    const written = record(row.kind, {
      actor: systemActor(),
      code: row.code,
      subject: { ...row.subject, ...evidenceFor(row.kind, last.evidence) },
    })
    // record() no-ops when the log is disabled or the kind is rate-limited. Advancing the durable
    // state for a row that was never written would permanently suppress the next one.
    if (!written) return
    await setNetworkState(next)
    emitUpdated?.()
  } catch (err) {
    log.warn('device episode step failed:', err.message)
  } finally {
    running = false
    // In `finally`: the try returns early on several paths, and an observation that arrived
    // mid-step must not wait for the next emit.
    if (pending) { pending = false; void pumpDevice() }
  }
}

export const peerLost = guarded((publicKey, spaceId, meta) => {
  if (!peers || degraded) return
  peers.lost(publicKey, spaceId, { now: Date.now(), meta })
  armPeerTimer()
})

export const peerSeen = guarded((publicKey, spaceId) => {
  if (!peers) return
  const row = peers.seen(publicKey, spaceId, { now: Date.now() })
  if (row) writePeerRow(row)
  armPeerTimer()
  relays?.returned(publicKey, Date.now())
  scheduleRelayTimer()
})

// The space name is resolved asynchronously by the caller, so it lands after the episode is open.
export const peerLostMeta = guarded((publicKey, spaceId, patch) => {
  peers?.annotate(publicKey, spaceId, patch)
})

// A leave is not a disconnect: member.left already tells that story, and joining against live
// membership at write time would break the log's zero-joins rule in the other direction.
export const peerLeft = guarded((publicKey, spaceId) => {
  peers?.abandon(publicKey, spaceId)
})

// Guarded like the exported hooks: this also runs from a bare setTimeout, where a throw would
// escape into the event loop as an uncaught exception. Each row is written in its own guard so one
// failure cannot drop the rest — their episodes are already flagged recorded.
const armPeerTimer = guarded(() => {
  if (peerTimer) { timers?.clear(peerTimer); peerTimer = null }
  const { rows, waitMs } = peers.step(Date.now())
  for (const row of rows) {
    try {
      writePeerRow(row)
    } catch (err) {
      log.warn('peer row write failed:', err.message)
    }
  }
  if (waitMs != null && canArm()) {
    peerTimer = timers.setTimeout(() => { peerTimer = null; armPeerTimer() }, waitMs + 50)
  }
})

// A relayed pairing that hyperdht upgrades to a direct path within the dwell is a bridge, not a
// fact worth a row. A socket whose member is not bound yet when the dwell fires re-arms. Which rows
// a held socket produces is relay-episodes.js's rule, and a row names the relay's provenance, never
// the relay's operator.
export const peerRelayed = guarded((socket, describe) => {
  cancelRelayDwell(socket)
  armRelayDwell(socket, describe)
})

export function setRelayReach(reachOf) {
  readReach = reachOf ?? (() => null)
}

// The socket left its relay: hyperdht moved it direct, or it closed. `personKey` is null when the
// socket's member is not known. The path is read here only to date the end of the stretch; whether
// it ended is read on the timer, after the close handlers have settled the registries.
export const peerUnrelayed = guarded((socket, personKey) => {
  cancelRelayDwell(socket)
  relays?.left(personKey, readReach, Date.now())
  scheduleRelayTimer()
})

function cancelRelayDwell(socket) {
  const handle = relayTimers.get(socket)
  if (!handle) return
  timers?.clear(handle)
  relayTimers.delete(socket)
}

const armRelayDwell = guarded((socket, describe) => {
  if (!canArm()) return
  relayTimers.set(socket, timers.setTimeout(guarded(() => {
    relayTimers.delete(socket)
    const info = describe()
    if (!info) return
    if (!info.personKey) { armRelayDwell(socket, describe); return }
    const row = relays.relayed(info, Date.now())
    if (row) writeRelayRow(row)
  }), relayDwellMs))
})

function scheduleRelayTimer() {
  if (!relays) return
  if (relayTimer) { timers?.clear(relayTimer); relayTimer = null }
  armRelayTimerIn(relays.waitMs(Date.now()))
}

function armRelayTimerIn(waitMs) {
  if (waitMs != null && canArm()) {
    relayTimer = timers.setTimeout(() => { relayTimer = null; settleRelays() }, waitMs + 50)
  }
}

// Guarded like armPeerTimer, for the same reasons.
const settleRelays = guarded(() => {
  const { rows, waitMs } = relays.step(Date.now(), readReach)
  for (const row of rows) {
    try {
      writeRelayRow(row)
    } catch (err) {
      log.warn('relay row write failed:', err.message)
    }
  }
  armRelayTimerIn(waitMs)
})

function writeRelayRow(row) {
  const { info } = row
  const actor = peerActor(info.personKey, info.displayName)
  const target = targetRef(TARGET_KIND.MEMBER, info.personKey, info.displayName)
  const written = row.suppressed
    ? record('audit.suppressed', { actor, target, subject: { kind: row.kind, count: row.cap, windowMs: row.windowMs } })
    : record(row.kind, { actor, target, subject: row.kind === KIND_PEER_RELAYED ? relayedSubject(info) : row.subject })
  if (written) { emitUpdated?.(); return }
  if (row.suppressed || row.kind === KIND_PEER_RELAYED) relays.refused(info.personKey)
}

function relayedSubject(info) {
  return {
    plane: info.plane,
    via: info.via,
    relay: truncateRelayKey(info.relayKey),
    provider: info.via === 'adopted' ? info.displayName : null,
    label: info.via === 'own' ? info.relayLabel || null : null,
  }
}

function writePeerRow(row) {
  const name = row.meta?.memberName ?? null
  const space = spaceRef(row.spaceId, row.meta?.spaceName)
  if (row.suppressed) {
    record('audit.suppressed', { space, subject: { kind: row.kind, count: row.cap, windowMs: row.windowMs } })
    return
  }
  const written = record(row.kind, {
    actor: peerActor(row.publicKey, name),
    space,
    target: targetRef(TARGET_KIND.MEMBER, row.publicKey, name),
    subject: row.subject,
  })
  if (written) emitUpdated?.()
}
