// Wires both pure trackers into the data layer: owns the timers, writes the rows, advances the
// durable device state, and enforces the one rule neither tracker can see on its own — a PEER row
// is only honest while OUR OWN connectivity is healthy. When this device is blocked every peer
// looks unreachable, and the device row already says why; writing "Anna went offline" for each of
// twenty members would blame twenty people for one pulled cable.
//
// The timers are not optional. Once the verdict is stable-blocked and the app is idle, swarm.js
// stops emitting status altogether (the liveness probe only emits when its failure COUNT changes),
// so "re-check on the next emit" would leave a held-down row unwritten forever.
import { createLogger } from '../core/logger.js'
import { record, getNetworkState, setNetworkState } from './audit-log.js'
import { createEpisodeTracker, evidenceFor } from './network-episodes.js'
import { createPeerPresenceTracker } from './peer-episodes.js'

const log = createLogger('network-watch')

let device = null
let peers = null
let deviceTimer = null
let peerTimer = null
let emitUpdated = null
let session = null
let last = null
let degraded = false
let running = false
let pending = false

export function initNetworkWatch({ emit = null, sessionId = null, dwellMs = 0, peerDwellMs = 0 } = {}) {
  device = createEpisodeTracker(dwellMs ? { dwellMs } : {})
  peers = createPeerPresenceTracker(peerDwellMs ? { dwellMs: peerDwellMs } : {})
  emitUpdated = emit
  // Distinguishes an outage that began in the run still going from one spanning a restart, which is
  // what makes the duration on a restored row honest — or, correctly, absent.
  session = sessionId || Date.now().toString(36)
  last = null
  degraded = false
}

export function resetNetworkWatch() {
  if (deviceTimer) { clearTimeout(deviceTimer); deviceTimer = null }
  if (peerTimer) { clearTimeout(peerTimer); peerTimer = null }
  device?.reset()
  peers?.reset()
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

    if (deviceTimer) { clearTimeout(deviceTimer); deviceTimer = null }
    if (waitMs != null) {
      deviceTimer = setTimeout(() => { deviceTimer = null; void pumpDevice() }, waitMs + 50)
      deviceTimer.unref?.()
    }
    if (!row) return

    const written = record(row.kind, {
      actor: { type: 'system', key: null, name: null },
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
    // The drain belongs HERE: several paths above return from inside the try, and a return runs
    // finally and then exits the function — anything after the try/finally is dead code on those
    // paths, so an observation that arrived mid-step would sit unprocessed until the next emit.
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
  if (peerTimer) { clearTimeout(peerTimer); peerTimer = null }
  const { rows, waitMs } = peers.step(Date.now())
  for (const row of rows) {
    try {
      writePeerRow(row)
    } catch (err) {
      log.warn('peer row write failed:', err.message)
    }
  }
  if (waitMs != null) {
    peerTimer = setTimeout(() => { peerTimer = null; armPeerTimer() }, waitMs + 50)
    peerTimer.unref?.()
  }
})

function writePeerRow(row) {
  const name = row.meta?.memberName ?? null
  const space = { id: row.spaceId, name: row.meta?.spaceName ?? null }
  if (row.suppressed) {
    record('audit.suppressed', { space, subject: { kind: row.kind, count: row.cap, windowMs: row.windowMs } })
    return
  }
  const written = record(row.kind, {
    actor: { type: 'peer', key: row.publicKey, name },
    space,
    target: { kind: 'member', id: row.publicKey, name },
    subject: row.subject,
  })
  if (written) emitUpdated?.()
}
