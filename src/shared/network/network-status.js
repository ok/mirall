// The frame the renderer renders from, and the one path that emits it. The swarm's facts are read
// once and the reachability verdict is folded from them; the emit path dedups against the last
// frame, debounces, emits, then audits. Both the dwell recheck and the audit ride the emit path
// because a read must not arm a timer, and the audit runs after the emit in its own guard so it
// cannot fail into the update it describes. The reporting defaults live here so status is
// answerable whether or not a Swarm subsystem was ever opened.
import b4a from 'b4a'
import hyperdht from 'hyperdht/package.json' with { type: 'json' }
import { classify, stabilise, BLOCKED_DWELL_MS } from '../core/reachability.js'
import { observeReachability } from '../audit/network-watch.js'
import { createLogger } from '../core/logger.js'
import { createTimers } from '../core/timers.js'
import { getContentPlaneStatus } from './content-swarm.js'
import { spaceTopics } from './swarm-registries.js'
import { createSwarmDiagnostics } from './swarm-diagnostics.js'
import { relaySelectionCount } from './relay-install.js'
import { snapshotRelayedConnections } from './relayed-connections.js'
import { canarySnapshot } from './canary-probe.js'
import { linkSnapshot } from './link-liveness.js'

const STATUS_EMIT_DEBOUNCE_MS = 300
const VERDICT_HISTORY_CAP = 200

let log = createLogger('network-status')
// Read at call time, not captured: the Swarm subsystem reassigns both handles across a restart.
let getSwarm = () => null
let getIpc = () => null
// The frame counters belong to the intake, which reaches back here for the status emit — so they
// arrive by injection rather than by an import that would close that loop.
let getDroppedFrameCounters = () => ({})
let readiness = () => ({})
let dhtVersion = typeof hyperdht.version === 'string' ? hyperdht.version : 'unknown'
let diag = createSwarmDiagnostics({
  getSwarm: () => getSwarm(),
  getRelaySelections: relaySelectionCount,
  getDhtVersion: () => dhtVersion,
  getRelayedConnections: snapshotRelayedConnections,
})
let timers = createTimers()

const unknownVerdict = () => ({ verdict: 'unknown', cause: null, confidence: 'predicted', evidence: null, since: 0, pending: null })
const freshState = () => ({
  verdict: unknownVerdict(),
  history: [],
  lastEmitted: null,
  emitTimer: null,
  dwellTimer: null,
})
let state = freshState()

// Only the swarm-scoped handles and the ledger are required; the rest override the defaults above
// and are supplied by tests that drive this module standalone.
export function initNetworkStatus(deps) {
  if (deps.log) log = deps.log
  if (deps.diag) diag = deps.diag
  if (deps.dhtVersion) dhtVersion = deps.dhtVersion
  if (deps.getDroppedFrameCounters) getDroppedFrameCounters = deps.getDroppedFrameCounters
  getSwarm = deps.getSwarm
  getIpc = deps.getIpc
  readiness = deps.readiness
}

function publicAddress(dht) {
  return {
    publicHost: typeof dht.host === 'string' ? dht.host : null,
    publicPort: typeof dht.port === 'number' ? dht.port : 0,
  }
}

function swarmState(swarm, dhtReady, peerCount) {
  if (swarm.suspended || swarm.destroyed || !dhtReady) return 'offline'
  return peerCount > 0 ? 'online' : 'connecting'
}

function readSwarmFacts(swarm) {
  const { dhtReady, announced, lastConnectionAt, bootedAt } = readiness()
  const dht = swarm.dht || {}
  const peerCount = swarm.connections?.size || 0
  return {
    state: swarmState(swarm, dhtReady, peerCount),
    dhtReady,
    announced,
    peerCount,
    connecting: swarm.connecting || 0,
    suspended: !!swarm.suspended,
    lastConnectionAt,
    bootedAt,
    identity: {
      publicKey: swarm.keyPair?.publicKey ? b4a.toString(swarm.keyPair.publicKey, 'hex') : '',
      nodeId: dht.id ? b4a.toString(dht.id, 'hex') : null,
    },
    address: { ...publicAddress(dht), localPort: diag.safeAddress().port },
    nat: {
      firewalled: dhtReady ? !!dht.firewalled : null,
      randomized: dhtReady ? !!dht.randomized : null,
      ephemeral: !!dht.ephemeral,
    },
    routing: { bootstrap: diag.getBootstrapList(), tableSize: diag.safeRoutingTableSize() },
    topics: spaceTopics.size,
    contentPlane: getContentPlaneStatus(),
    stats: diag.snapshotStats(),
    peerReach: diag.snapshotPeerReach(),
    dhtHealth: diag.snapshotDhtHealth(),
    canary: canarySnapshot(),
    liveness: linkSnapshot(),
    relay: diag.snapshotRelay(),
    versions: { dht: dhtVersion },
  }
}

function foldReachability(facts, swarm) {
  const { bootedAt, readyAt, dhtReady, browserOnline } = readiness()
  const now = Date.now()
  const raw = classify({
    now,
    bootedAt,
    readyAt,
    dhtReady,
    suspended: !!swarm.suspended || !!swarm.destroyed,
    browserOnline,
    hasInterface: facts.liveness.interfaceKind !== 'none',
    interfaceKind: facts.liveness.interfaceKind,
    address: facts.address,
    routing: facts.routing,
    dhtHealth: facts.dhtHealth,
    peerReach: facts.peerReach,
    dials: facts.stats.connects.client,
    canary: facts.canary,
    liveness: facts.liveness,
  })
  state.verdict = stabilise(raw, state.verdict, now)
  return state.verdict
}

export function getSwarmStatus() {
  const swarm = getSwarm()
  if (!swarm) return diag.offlineStatusSnapshot()
  const facts = readSwarmFacts(swarm)
  return { ...facts, reachability: foldReachability(facts, swarm) }
}

function recordVerdict(next) {
  const prev = state.history[state.history.length - 1]
  if (prev && prev.verdict === next.verdict && prev.cause === next.cause) return
  state.history.push({ at: Date.now(), verdict: next.verdict, cause: next.cause, confidence: next.confidence })
  if (state.history.length > VERDICT_HISTORY_CAP) state.history.shift()
}

export function getVerdictHistory() {
  return state.history.slice()
}

export function getPeerSamples() {
  return diag.snapshotPeerSamples()
}

export function getDiagnosticCounters() {
  const { readyAt = 0, bootedAt = 0, hostChangeCount = 0 } = readiness()
  return {
    readyAt,
    bootedAt,
    hostChangeCount,
    localPortStable: diag.safeAddress().port > 0,
    droppedFrames: getDroppedFrameCounters(),
  }
}

// The scalar leaves the dedup compares: two frames are equal iff every one matches.
/** @internal */
export const STATUS_PATHS = [
  'state', 'dhtReady', 'announced', 'peerCount', 'connecting', 'suspended',
  'lastConnectionAt', 'bootedAt',
  'identity.publicKey', 'identity.nodeId',
  'address.publicHost', 'address.publicPort', 'address.localPort',
  'nat.firewalled', 'nat.randomized', 'nat.ephemeral',
  'routing.tableSize', 'topics', 'stats.updates',
  'stats.connects.client.opened', 'stats.connects.client.closed',
  'stats.connects.server.opened', 'stats.connects.server.closed',
  'stats.bannedPeers',
  'stats.relaying.selected', 'stats.relaying.attempts', 'stats.relaying.successes', 'stats.relaying.aborts',
  'peerReach.discovered', 'peerReach.connected', 'peerReach.exhausted',
  'dhtHealth.online', 'dhtHealth.degraded', 'dhtHealth.timeoutsRate',
  'canary.state', 'canary.at',
  'liveness.failures', 'liveness.interfaceKind',
  'relay.digest', 'relay.direct.control', 'relay.direct.content',
  'reachability.verdict', 'reachability.cause', 'reachability.confidence',
]

const leaf = (obj, path) => path.split('.').reduce((o, key) => o?.[key], obj)

/** @internal */
export function statusEqual(a, b) {
  if (a === b) return true
  if (!a || !b) return false
  return STATUS_PATHS.every((path) => leaf(a, path) === leaf(b, path))
}

// A blocked user generates less swarm activity, not more, so a pending escalation would otherwise
// sit unemitted until something unrelated happened.
function armDwellRecheck(pending) {
  if (state.dwellTimer) { timers.clear(state.dwellTimer); state.dwellTimer = null }
  if (!pending) return
  state.dwellTimer = timers.setTimeout(() => { state.dwellTimer = null; scheduleStatusEmit() }, BLOCKED_DWELL_MS / 2)
}

function audit(status) {
  observeReachability({
    verdict: status.reachability.verdict,
    cause: status.reachability.cause,
    since: status.reachability.since,
    evidence: {
      confidence: status.reachability.confidence,
      peersDiscovered: status.peerReach.discovered,
      peersExhausted: status.peerReach.exhausted,
      peersConnected: status.peerReach.connected,
      publicPort: status.address.publicPort,
      interfaceKind: status.liveness.interfaceKind,
    },
  })
}

function emitStatus() {
  if (!getIpc()) return
  const next = getSwarmStatus()
  armDwellRecheck(next.reachability?.pending)
  if (statusEqual(next, state.lastEmitted)) return
  state.lastEmitted = next
  recordVerdict(next.reachability)
  try {
    getIpc().emit('event:network-status', next)
  } catch (err) {
    log.warn('status emit failed:', err.message)
  }
  try {
    audit(next)
  } catch (err) {
    log.warn('connectivity audit skipped:', err.message)
  }
}

export function scheduleStatusEmit() {
  if (state.emitTimer) return
  state.emitTimer = timers.setTimeout(() => {
    state.emitTimer = null
    emitStatus()
  }, STATUS_EMIT_DEBOUNCE_MS)
}

export function resetNetworkStatus() {
  timers.close()
  timers = createTimers()
  state = freshState()
}
