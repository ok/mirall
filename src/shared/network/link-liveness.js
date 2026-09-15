// Catches a silently-dead link. Two signals, one unit: the routable-interface kind, a local syscall
// that says "no network at all" instantly and for the right reason, and a ping against our own
// routing table that runs only while no connected peer can vouch for us. A route reappearing
// restarts the ping count rather than continuing it.
import { routableAddressKind, LIVENESS_FAILURES_FOR_OFFLINE } from '../core/reachability.js'
import { withReadTimeout } from '../core/with-timeout.js'
import { createLogger } from '../core/logger.js'
import { createTimers } from '../core/timers.js'

const INTERFACE_POLL_MS = 3000
const LIVENESS_INTERVAL_MS = 15000
const LIVENESS_RETRY_MS = 2000
const LIVENESS_TIMEOUT_MS = 5000

let log = createLogger('link-liveness')
let getSwarm = () => null
let isDhtReady = () => false
let readInterfaces = () => ({})
let onChange = () => {}
let timers = createTimers()

const freshState = () => ({
  failures: 0,
  checkedAt: 0,
  interfaceKind: 'physical',
  started: false,
  retryTimer: null,
})
let state = freshState()

export function initLinkLiveness(deps) {
  if (deps.log) log = deps.log
  getSwarm = deps.getSwarm
  isDhtReady = deps.isDhtReady
  readInterfaces = deps.readInterfaces
  onChange = deps.onChange
}

export function linkSnapshot() {
  return { failures: state.failures, checkedAt: state.checkedAt, interfaceKind: state.interfaceKind }
}

export function clearLinkFailures() {
  state.failures = 0
}

function readInterfaceKind() {
  try {
    return routableAddressKind(readInterfaces())
  } catch {
    // Never invent an outage from a failed read.
    return 'physical'
  }
}

function pollInterfaces() {
  const next = readInterfaceKind()
  if (next === state.interfaceKind) return
  if (state.interfaceKind === 'none' && next !== 'none') state.failures = 0
  state.interfaceKind = next
  onChange()
}

// Routing-table entries only: they are real IPs seen over the wire. The bootstrap list is
// hostnames, which dht.ping() rejects instantly, and that rejection would count as a failure.
function pingTarget(dht) {
  try {
    const nodes = dht.toArray({ limit: 8 })
    if (nodes && nodes.length) return nodes[Math.floor(nodes.length / 2)]
  } catch {}
  return null
}

function ping(dht, target) {
  return Promise.resolve().then(() => dht.ping(target)).then(() => true, () => false)
}

async function checkLiveness() {
  const swarm = getSwarm()
  const dht = swarm?.dht
  if (!dht || !isDhtReady() || swarm.suspended || swarm.destroyed) return
  if (swarm.connections?.size > 0) { state.failures = 0; return }

  const target = pingTarget(dht)
  if (!target) return

  const alive = await withReadTimeout(ping(dht, target), LIVENESS_TIMEOUT_MS, false)
  const before = state.failures
  state.failures = alive ? 0 : Math.min(state.failures + 1, LIVENESS_FAILURES_FOR_OFFLINE)
  state.checkedAt = Date.now()
  if (before !== state.failures) onChange()

  // Confirm a first failure promptly rather than after another full interval.
  if (!alive && state.failures < LIVENESS_FAILURES_FOR_OFFLINE) scheduleRetry()
}

function runCheck(label) {
  checkLiveness().catch((err) => log.debug(label, 'failed:', err.message))
}

function scheduleRetry() {
  if (state.retryTimer) return
  state.retryTimer = timers.setTimeout(() => {
    state.retryTimer = null
    runCheck('liveness retry')
  }, LIVENESS_RETRY_MS)
}

// Lets a network transition the OS did notice trigger an immediate re-check.
export async function checkLivenessNow() {
  await checkLiveness()
  return { failures: state.failures, checkedAt: state.checkedAt }
}

export function startLinkLiveness() {
  if (state.started) return
  state.started = true
  state.interfaceKind = readInterfaceKind()
  timers.setInterval(pollInterfaces, INTERFACE_POLL_MS)
  timers.setInterval(() => runCheck('liveness check'), LIVENESS_INTERVAL_MS)
}

export function resetLinkLiveness() {
  timers.close()
  timers = createTimers()
  state = freshState()
}
