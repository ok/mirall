// Are we reachable, and can we say so? Everything the swarm knows about its own connectivity: the
// DHT's readiness and NAT verdict, the canary probe that distinguishes "blocked" from "quiet", the
// liveness poll and interface watch that catch a silently-dead link, and the debounced status frame
// the renderer renders from. It reads the swarm handle and reports; it never joins, dials or admits.
//
// Extracted because none of it is connection handling. Its sixteen counters and timers were the
// single largest group destroySwarm cleared by hand, and every one is private to this file — the
// connection layer only ever announced three events into it, which are now three note* calls.
import b4a from 'b4a'
import os from 'bare-os'
import crypto from 'hypercore-crypto'
import idEncoding from 'hypercore-id-encoding'
import { getUpgradeKey } from '../core/runtime-config.js'
import { refreshContentDiscoveries, getContentPlaneStatus } from './content-swarm.js'
import { observeReachability } from '../audit/network-watch.js'
import {
  classify, stabilise, routableAddressKind, CANARY, BLOCKED_DWELL_MS, NAT_SETTLE_MS,
  LIVENESS_FAILURES_FOR_OFFLINE,
} from '../core/reachability.js'
import { spaceTopics, spaceDiscoveries } from './swarm-registries.js'

let log = null
let diag = null
let dhtVersion = 'unknown'
let getDroppedFrameCounters = () => ({})
// Read at call time, not captured: initSwarm and destroySwarm reassign both handles.
let getSwarm = () => null
let getIpc = () => null

export function initConnectivity(deps) {
  log = deps.log
  diag = deps.diag
  dhtVersion = deps.dhtVersion
  getDroppedFrameCounters = deps.getDroppedFrameCounters
  getSwarm = deps.getSwarm
  getIpc = deps.getIpc
}

let dhtReady = false
let readyAt = 0
let announced = false
let hostChangeCount = 0
let lastKnownHost = null
let currentReachability = { verdict: 'unknown', cause: null, confidence: 'predicted', evidence: null, since: 0, pending: null }
let verdictHistory = []
let lastCanaryResult = { state: CANARY.UNAVAILABLE, at: 0 }
let browserOnlineHint = true
let lastConnectionAt = null
let lastEmittedStatus = null
let statusEmitTimer = null
let lastReconnectAt = 0
let bootedAt = 0
const STATUS_EMIT_DEBOUNCE_MS = 300
const RECONNECT_THROTTLE_MS = 5000

// Everything the swarm and its DHT tell us about our own reachability. Bound in one place so the
// connection layer does not have to know which events feed the status frame.
export function attachSwarmWatchers() {
  const swarm = getSwarm()
  swarm.on('update', scheduleStatusEmit)

  const onDhtReady = () => {
    // fullyBootstrapped() can resolve after destroySwarm; without this the liveness and interface
    // loops are re-armed on a swarm that no longer exists.
    if (!getSwarm() || dhtReady) return
    dhtReady = true
    readyAt = Date.now()
    scheduleStatusEmit()
    scheduleFirstCanaryProbe()
    startLivenessLoop()
    startInterfaceWatch()
  }
  swarm.dht.on('ready', onDhtReady)
  swarm.dht.fullyBootstrapped().then(onDhtReady, () => {})
  swarm.dht.on('persistent', scheduleStatusEmit)
  swarm.dht.on('network-change', scheduleStatusEmit)
  swarm.dht.on('wake-up', scheduleStatusEmit)
  swarm.dht.on('nat-update', (host) => {
    if (typeof host === 'string' && lastKnownHost !== null && host !== lastKnownHost) hostChangeCount++
    if (typeof host === 'string') lastKnownHost = host
    scheduleStatusEmit()
  })
}

// The three things the connection layer observes on our behalf.
export function noteBooted() { bootedAt = Date.now() }

export function noteConnection() {
  livenessFailures = 0
  lastConnectionAt = Date.now()
  scheduleStatusEmit()
}

export function noteAnnounced() {
  announced = true
  scheduleStatusEmit()
}


const VERDICT_HISTORY_CAP = 200

function recordVerdictTransition(next) {
  const prev = verdictHistory[verdictHistory.length - 1]
  if (prev && prev.verdict === next.verdict && prev.cause === next.cause) return
  verdictHistory.push({ at: Date.now(), verdict: next.verdict, cause: next.cause, confidence: next.confidence })
  if (verdictHistory.length > VERDICT_HISTORY_CAP) verdictHistory.shift()
}

function recomputeReachability() {
  const dht = getSwarm()?.dht || {}
  const stats = diag.snapshotStats()
  const now = Date.now()
  const raw = classify({
    now,
    bootedAt,
    readyAt,
    dhtReady,
    suspended: !!getSwarm()?.suspended || !!getSwarm()?.destroyed,
    browserOnline: browserOnlineHint,
    hasInterface: interfaceKind !== 'none',
    interfaceKind,
    address: {
      publicHost: typeof dht.host === 'string' ? dht.host : null,
      publicPort: typeof dht.port === 'number' ? dht.port : 0,
    },
    routing: { tableSize: diag.safeRoutingTableSize() },
    dhtHealth: diag.snapshotDhtHealth(),
    peerReach: diag.snapshotPeerReach(),
    dials: { attempted: stats.connects.client.attempted, opened: stats.connects.client.opened },
    canary: lastCanaryResult,
    liveness: { failures: livenessFailures, checkedAt: livenessCheckedAt },
  })
  currentReachability = stabilise(raw, currentReachability, now)
  recordVerdictTransition(currentReachability)
  return currentReachability
}

export function setBrowserOnlineHint(online) {
  const next = online !== false
  if (next === browserOnlineHint) return
  browserOnlineHint = next
  scheduleStatusEmit()
}

export function getVerdictHistory() {
  return verdictHistory.slice()
}

export function getDiagnosticCounters() {
  return {
    readyAt,
    bootedAt,
    hostChangeCount,
    localPortStable: diag.safeAddress().port > 0,
    droppedFrames: getDroppedFrameCounters(),
  }
}

export function getPeerSamples() {
  return diag.snapshotPeerSamples()
}

const CANARY_TIMEOUT_MS = 10000
const CANARY_MIN_INTERVAL_MS = 15 * 60 * 1000
const CANARY_MAX_DIALS = 3

let canaryInFlight = null
let lastCanaryAt = 0

function parseUpgradeKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const bare = raw.replace(/^pear:\/\//, '').split('/')[0].trim()
  if (!bare) return null
  try {
    const key = idEncoding.decode(bare)
    return key.byteLength === 32 ? key : null
  } catch { return null }
}

function dialOnce(dht, peer) {
  return new Promise((resolve) => {
    let socket = null
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      if (socket) { try { socket.destroy() } catch {} }
      resolve(ok)
    }
    const timer = setTimeout(() => finish(false), CANARY_TIMEOUT_MS)
    timer.unref?.()
    try {
      socket = dht.connect(peer.publicKey, { relayAddresses: peer.relayAddresses })
      socket.on('open', () => finish(true))
      socket.on('error', () => finish(false))
      socket.on('close', () => finish(false))
    } catch (err) {
      log.debug('canary dial threw:', err.message)
      finish(false)
    }
  })
}

// Two stages, because a single probe cannot distinguish "your network is broken" from
// "our seeder is down". Stage 1 asks the DHT whether the seeder is announcing at all; if
// it is not, we report seeder-down and the reducer leaves the user's verdict untouched.
async function runCanaryProbe(upgradeKey) {
  const driveKey = parseUpgradeKey(upgradeKey)
  if (!driveKey) return { state: CANARY.UNAVAILABLE, reason: 'no-key' }
  const dht = getSwarm()?.dht
  if (!dht || !dhtReady) return { state: CANARY.UNAVAILABLE, reason: 'no-dht' }

  const topic = crypto.discoveryKey(driveKey)
  const found = []
  const stream = dht.lookup(topic)
  const stage1Started = Date.now()
  const stage1Timer = setTimeout(() => { try { stream.destroy() } catch {} }, CANARY_TIMEOUT_MS)
  stage1Timer.unref?.()
  try {
    for await (const reply of stream) {
      for (const peer of reply.peers || []) {
        if (found.length >= CANARY_MAX_DIALS) break
        found.push(peer)
      }
      if (found.length >= CANARY_MAX_DIALS) break
    }
  } catch (err) {
    log.debug('canary lookup failed:', err.message)
  } finally {
    clearTimeout(stage1Timer)
    try { stream.destroy() } catch {}
  }
  const stage1 = { announceRecords: found.length, ms: Date.now() - stage1Started }

  if (found.length === 0) return { state: CANARY.SEEDER_DOWN, stage1 }

  const stage2Started = Date.now()
  let dials = 0
  for (const peer of found) {
    dials++
    if (await dialOnce(dht, peer)) {
      return { state: CANARY.REACHABLE, stage1, stage2: { dials, opened: 1, ms: Date.now() - stage2Started } }
    }
  }
  return { state: CANARY.UNREACHABLE, stage1, stage2: { dials, opened: 0, ms: Date.now() - stage2Started } }
}

// Tier 2 needs joined topics to produce evidence, so a user with no spaces has only the
// NAT shape — a prediction. One automatic probe turns it into a measurement. Deliberately
// not on a timer: this fires once per swarm, and every other probe is user-initiated.
let firstProbeTimer = null

// Only runs while nothing else can produce evidence — with peers connected, their presence
// IS the liveness signal, and a periodic ping from every idle client would be pointless
// DHT traffic. Targets our own routing table (public infrastructure built for exactly
// this), never the seeder.
// A local syscall, not a network round-trip: if the machine has no non-internal address
// there is definitively no network, and we can say so instantly instead of waiting for
// probes to time out — and say the *right* thing, rather than blaming a VPN or a router.
const INTERFACE_POLL_MS = 3000

let interfaceKind = 'physical'
let interfaceTimer = null

function readInterfaceKind() {
  try {
    return routableAddressKind(os.networkInterfaces())
  } catch {
    // Never invent an outage from a failed read.
    return 'physical'
  }
}

function startInterfaceWatch() {
  if (interfaceTimer) return
  interfaceKind = readInterfaceKind()
  interfaceTimer = setInterval(() => {
    const next = readInterfaceKind()
    if (next === interfaceKind) return
    // A route reappearing is a fresh start for the probe, not a continuation.
    if (interfaceKind === 'none' && next !== 'none') livenessFailures = 0
    interfaceKind = next
    scheduleStatusEmit()
  }, INTERFACE_POLL_MS)
  interfaceTimer.unref?.()
}

const LIVENESS_INTERVAL_MS = 15000
const LIVENESS_RETRY_MS = 2000
const LIVENESS_TIMEOUT_MS = 5000

let livenessTimer = null
let livenessFailures = 0
let livenessCheckedAt = 0

// Routing-table entries only: they are real IPs seen over the wire. The bootstrap list is
// hostnames, and dht.ping() rejects those instantly as "not a valid IP address" — which
// would be counted as a failure and declare a healthy network dead.
function livenessTarget() {
  const dht = getSwarm()?.dht
  if (!dht) return null
  try {
    const nodes = dht.toArray({ limit: 8 })
    if (nodes && nodes.length) return nodes[Math.floor(nodes.length / 2)]
  } catch {}
  return null
}

async function checkLiveness() {
  const swarm = getSwarm()
  const dht = swarm?.dht
  if (!dht || !dhtReady || swarm.suspended || swarm.destroyed) return
  if (swarm.connections?.size > 0) { livenessFailures = 0; return }

  const target = livenessTarget()
  if (!target) return

  let timer = null
  const timeout = new Promise((resolve) => {
    timer = setTimeout(() => resolve(false), LIVENESS_TIMEOUT_MS)
    timer.unref?.()
  })
  let alive = false
  try {
    alive = await Promise.race([dht.ping(target).then(() => true, () => false), timeout])
  } catch { alive = false }
  clearTimeout(timer)

  const before = livenessFailures
  livenessFailures = alive ? 0 : Math.min(livenessFailures + 1, LIVENESS_FAILURES_FOR_OFFLINE)
  livenessCheckedAt = Date.now()
  if (before !== livenessFailures) scheduleStatusEmit()

  // Confirm a first failure promptly rather than after another full interval.
  if (!alive && livenessFailures < LIVENESS_FAILURES_FOR_OFFLINE) scheduleLivenessRetry()
}

let livenessRetryTimer = null

function scheduleLivenessRetry() {
  if (livenessRetryTimer) return
  livenessRetryTimer = setTimeout(() => {
    livenessRetryTimer = null
    checkLiveness().catch((err) => log.debug('liveness retry failed:', err.message))
  }, LIVENESS_RETRY_MS)
  livenessRetryTimer.unref?.()
}

// Lets a network transition the OS *did* notice trigger an immediate re-check instead of
// waiting out the interval.
export async function checkLivenessNow() {
  await checkLiveness()
  return { failures: livenessFailures, checkedAt: livenessCheckedAt }
}

function startLivenessLoop() {
  if (livenessTimer) return
  livenessTimer = setInterval(() => {
    checkLiveness().catch((err) => log.debug('liveness check failed:', err.message))
  }, LIVENESS_INTERVAL_MS)
  livenessTimer.unref?.()
}

function scheduleFirstCanaryProbe() {
  if (firstProbeTimer || spaceTopics.size > 0) return
  firstProbeTimer = setTimeout(() => {
    firstProbeTimer = null
    if (spaceTopics.size > 0) return
    probeCanary(getUpgradeKey()).catch((err) => log.debug('first canary probe failed:', err.message))
  }, NAT_SETTLE_MS)
  firstProbeTimer.unref?.()
}

export async function probeCanary(upgradeKey, { force = false } = {}) {
  const now = Date.now()
  if (!force) {
    if (now - lastCanaryAt < CANARY_MIN_INTERVAL_MS) return lastCanaryResult
    if (canaryInFlight) return canaryInFlight
  }

  canaryInFlight = runCanaryProbe(upgradeKey)
    .then((result) => {
      lastCanaryResult = { ...result, at: Date.now() }
      lastCanaryAt = Date.now()
      scheduleStatusEmit()
      return lastCanaryResult
    })
    .catch((err) => {
      log.debug('canary probe failed:', err.message)
      lastCanaryResult = { state: CANARY.UNAVAILABLE, at: Date.now() }
      return lastCanaryResult
    })
    .finally(() => { canaryInFlight = null })

  return canaryInFlight
}

export function getSwarmStatus() {
  const swarm = getSwarm()
  if (!swarm) return diag.offlineStatusSnapshot()

  const reachability = recomputeReachability()

  const peerCount = swarm.connections?.size || 0
  const connecting = swarm.connecting || 0
  const suspended = !!swarm.suspended
  const destroyed = !!swarm.destroyed
  const state = (suspended || destroyed || !dhtReady)
    ? 'offline'
    : peerCount > 0 ? 'online' : 'connecting'

  const dht = swarm.dht || {}
  const addr = diag.safeAddress()
  const pubKey = swarm.keyPair?.publicKey
    ? b4a.toString(swarm.keyPair.publicKey, 'hex')
    : ''
  const nodeId = dht.id ? b4a.toString(dht.id, 'hex') : null

  return {
    state,
    dhtReady,
    announced,
    peerCount,
    connecting,
    suspended,
    lastConnectionAt,
    bootedAt,
    identity: { publicKey: pubKey, nodeId },
    address: {
      publicHost: typeof dht.host === 'string' ? dht.host : null,
      publicPort: typeof dht.port === 'number' ? dht.port : 0,
      localPort: addr.port,
    },
    nat: {
      firewalled: dhtReady ? !!dht.firewalled : null,
      randomized: dhtReady ? !!dht.randomized : null,
      ephemeral: !!dht.ephemeral,
    },
    routing: {
      bootstrap: diag.getBootstrapList(),
      tableSize: diag.safeRoutingTableSize(),
    },
    topics: spaceTopics.size,
    contentPlane: getContentPlaneStatus(),
    stats: diag.snapshotStats(),
    peerReach: diag.snapshotPeerReach(),
    dhtHealth: diag.snapshotDhtHealth(),
    canary: lastCanaryResult,
    liveness: { failures: livenessFailures, checkedAt: livenessCheckedAt, interfaceKind },
    reachability,
    versions: { dht: dhtVersion },
  }
}

// The scalar fields the network-status dedup compares — a status is "equal" iff all match. Kept as
// a list of accessors (rather than a 24-term && chain) so the comparison stays flat and a new field
// is one line. Sub-objects (identity/address/nat/stats) are assumed present, as before; the top
// level is guarded in statusEqual.
const STATUS_FIELDS = [
  (s) => s.state,
  (s) => s.dhtReady,
  (s) => s.announced,
  (s) => s.peerCount,
  (s) => s.connecting,
  (s) => s.suspended,
  (s) => s.lastConnectionAt,
  (s) => s.bootedAt,
  (s) => s.identity.publicKey,
  (s) => s.identity.nodeId,
  (s) => s.address.publicHost,
  (s) => s.address.publicPort,
  (s) => s.address.localPort,
  (s) => s.nat.firewalled,
  (s) => s.nat.randomized,
  (s) => s.nat.ephemeral,
  (s) => s.routing.tableSize,
  (s) => s.topics,
  (s) => s.stats.updates,
  (s) => s.stats.connects.client.opened,
  (s) => s.stats.connects.client.closed,
  (s) => s.stats.connects.server.opened,
  (s) => s.stats.connects.server.closed,
  (s) => s.stats.bannedPeers,
  // Without these three the status emitter's dedup drops every relay counter change
  // and the diagnostics screen never updates.
  (s) => s.stats.relaying.selected,
  (s) => s.stats.relaying.attempts,
  (s) => s.stats.relaying.successes,
  (s) => s.stats.relaying.aborts,
  (s) => s.peerReach.discovered,
  (s) => s.peerReach.connected,
  (s) => s.peerReach.exhausted,
  (s) => s.dhtHealth.online,
  (s) => s.dhtHealth.degraded,
  (s) => s.dhtHealth.timeoutsRate,
  (s) => s.canary.state,
  (s) => s.canary.at,
  (s) => s.liveness.failures,
  (s) => s.liveness.interfaceKind,
  (s) => s.reachability.verdict,
  (s) => s.reachability.cause,
  (s) => s.reachability.confidence,
]

export function statusEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return STATUS_FIELDS.every((field) => field(a) === field(b))
}

// A blocked user generates LESS swarm activity, not more, so a pending escalation would
// otherwise sit unemitted until something unrelated happened. One-shot and armed only
// from the emit path — never from getSwarmStatus, which is a read and must not start
// timers that outlive destroySwarm.
let dwellTimer = null

function armDwellRecheck(pending) {
  if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null }
  if (!pending) return
  dwellTimer = setTimeout(() => { dwellTimer = null; scheduleStatusEmit() }, BLOCKED_DWELL_MS / 2)
  dwellTimer.unref?.()
}

export function scheduleStatusEmit() {
  if (statusEmitTimer) return
  statusEmitTimer = setTimeout(() => {
    statusEmitTimer = null
    if (!getIpc()) return
    const next = getSwarmStatus()
    armDwellRecheck(next.reachability?.pending)
    if (statusEqual(next, lastEmittedStatus)) return
    lastEmittedStatus = next
    try {
      getIpc().emit('event:network-status', next)
    } catch (err) {
      log.warn('status emit failed:', err.message)
    }
    // AFTER the emit, and in its own guard: auditing must never fail into the operation it
    // describes, and a throw here would otherwise leave the UI without a status update. It rides
    // the EMIT path rather than getSwarmStatus because that is a read and must not start timers
    // (see armDwellRecheck above); the tracker owns its own hold-down timer, so a stable-blocked
    // idle app still gets its row.
    try {
      observeReachability({
        verdict: next.reachability.verdict,
        cause: next.reachability.cause,
        since: next.reachability.since,
        evidence: {
          confidence: next.reachability.confidence,
          peersDiscovered: next.peerReach.discovered,
          peersExhausted: next.peerReach.exhausted,
          peersConnected: next.peerReach.connected,
          publicPort: next.address.publicPort,
          interfaceKind: next.liveness.interfaceKind,
        },
      })
    } catch (err) {
      log.warn('connectivity audit skipped:', err.message)
    }
  }, STATUS_EMIT_DEBOUNCE_MS)
}

export async function reconnectAll() {
  const now = Date.now()
  if (now - lastReconnectAt < RECONNECT_THROTTLE_MS) {
    return { ok: false, throttled: true }
  }
  lastReconnectAt = now
  log.info('reconnect requested for', spaceDiscoveries.size, 'topics')
  for (const [spaceId, discovery] of spaceDiscoveries) {
    try {
      await discovery.refresh({ client: true, server: true })
      log.debug('refreshed discovery for', spaceId)
    } catch (err) {
      log.warn('refresh failed for', spaceId, err.message)
    }
  }
  try { await refreshContentDiscoveries() } catch {} // content plane (no-op unless active)
  scheduleStatusEmit()
  return { ok: true }
}

// What destroySwarm calls instead of clearing sixteen counters and six timers by hand.
export function resetConnectivity() {
  if (dwellTimer) { clearTimeout(dwellTimer); dwellTimer = null }
  if (firstProbeTimer) { clearTimeout(firstProbeTimer); firstProbeTimer = null }
  if (livenessTimer) { clearInterval(livenessTimer); livenessTimer = null }
  if (interfaceTimer) { clearInterval(interfaceTimer); interfaceTimer = null }
  if (livenessRetryTimer) { clearTimeout(livenessRetryTimer); livenessRetryTimer = null }
  if (statusEmitTimer) { clearTimeout(statusEmitTimer); statusEmitTimer = null }
  dhtReady = false
  readyAt = 0
  announced = false
  lastConnectionAt = null
  lastEmittedStatus = null
  hostChangeCount = 0
  lastKnownHost = null
  currentReachability = { verdict: 'unknown', cause: null, confidence: 'predicted', evidence: null, since: 0, pending: null }
  verdictHistory = []
  lastCanaryResult = { state: CANARY.UNAVAILABLE, at: 0 }
  lastCanaryAt = 0
  livenessFailures = 0
  livenessCheckedAt = 0
  interfaceKind = 'physical'
  canaryInFlight = null
  browserOnlineHint = true
  lastReconnectAt = 0
  bootedAt = 0
}
