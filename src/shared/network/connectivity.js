// Are we reachable, and can we say so? This is the swarm-fact ledger — what the DHT and the
// connection layer told us about our own connectivity — and the root that wires the canary probe,
// the link-liveness watch and the status frame around it.
import os from 'bare-os'
import { createLogger } from '../core/logger.js'
import { initCanaryProbe, scheduleFirstCanaryProbe, resetCanaryProbe } from './canary-probe.js'
import { initLinkLiveness, startLinkLiveness, clearLinkFailures, resetLinkLiveness } from './link-liveness.js'
import { initNetworkStatus, scheduleStatusEmit, resetNetworkStatus } from './network-status.js'

// Read at call time, not captured: the Swarm subsystem reassigns both handles across a restart.
let getSwarm = () => null
let getIpc = () => null
let log = createLogger('connectivity')

const freshLedger = () => ({
  dhtReady: false,
  readyAt: 0,
  bootedAt: 0,
  announced: false,
  lastConnectionAt: null,
  browserOnline: true,
  hostChangeCount: 0,
  lastKnownHost: null,
})
let ledger = freshLedger()

// Only the two swarm-scoped handles are required; the rest override the leaves' defaults and are
// supplied by tests that drive this module standalone.
export function initConnectivity(deps) {
  if (deps.log) log = deps.log
  getSwarm = deps.getSwarm || (() => null)
  getIpc = deps.getIpc || (() => null)

  initCanaryProbe({
    log,
    getDht: () => (ledger.dhtReady && getSwarm()?.dht) || null,
    onResult: scheduleStatusEmit,
  })
  initLinkLiveness({
    log,
    getSwarm: () => getSwarm(),
    isDhtReady: () => ledger.dhtReady,
    readInterfaces: () => os.networkInterfaces(),
    onChange: scheduleStatusEmit,
  })
  initNetworkStatus({
    log,
    diag: deps.diag,
    dhtVersion: deps.dhtVersion,
    getDroppedFrameCounters: deps.getDroppedFrameCounters,
    getSwarm: () => getSwarm(),
    getIpc: () => getIpc(),
    readiness: () => ledger,
  })
}

function noteNatHost(host) {
  if (typeof host === 'string') {
    if (ledger.lastKnownHost !== null && host !== ledger.lastKnownHost) ledger.hostChangeCount++
    ledger.lastKnownHost = host
  }
  scheduleStatusEmit()
}

function onDhtReady() {
  // fullyBootstrapped() can resolve after the swarm is destroyed; without this the liveness and
  // interface loops are re-armed on a swarm that no longer exists.
  if (!getSwarm() || ledger.dhtReady) return
  ledger.dhtReady = true
  ledger.readyAt = Date.now()
  scheduleStatusEmit()
  scheduleFirstCanaryProbe()
  startLinkLiveness()
}

export function attachSwarmWatchers() {
  const swarm = getSwarm()
  swarm.on('update', scheduleStatusEmit)
  swarm.dht.on('ready', onDhtReady)
  swarm.dht.fullyBootstrapped().then(onDhtReady, () => {})
  swarm.dht.on('persistent', scheduleStatusEmit)
  swarm.dht.on('network-change', scheduleStatusEmit)
  swarm.dht.on('wake-up', scheduleStatusEmit)
  swarm.dht.on('nat-update', noteNatHost)
}

export function noteBooted() {
  ledger.bootedAt = Date.now()
}

export function noteConnection() {
  clearLinkFailures()
  ledger.lastConnectionAt = Date.now()
  scheduleStatusEmit()
}

export function noteAnnounced() {
  ledger.announced = true
  scheduleStatusEmit()
}

export function setBrowserOnlineHint(online) {
  const next = online !== false
  if (next === ledger.browserOnline) return
  ledger.browserOnline = next
  scheduleStatusEmit()
}

export function resetConnectivity() {
  getSwarm = () => null
  getIpc = () => null
  resetCanaryProbe()
  resetLinkLiveness()
  resetNetworkStatus()
  ledger = freshLedger()
}
