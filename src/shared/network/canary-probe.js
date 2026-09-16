// The two-stage seeder probe. One probe cannot tell "your network is broken" from "our seeder is
// down": stage 1 asks the DHT whether the seeder announces at all, and only an announcing seeder
// that refuses every dial counts against the user. The probe dials with an ephemeral identity, and
// the newest probe's verdict always wins over a slower one that settles later.
import crypto from 'hypercore-crypto'
import idEncoding from 'hypercore-id-encoding'
import { CANARY, NAT_SETTLE_MS } from '../core/reachability.js'
import { getUpgradeKey } from '../core/runtime-config.js'
import { createLogger } from '../core/logger.js'
import { createTimers } from '../core/timers.js'
import { spaceTopics } from './swarm-registries.js'

const CANARY_TIMEOUT_MS = 10000
const CANARY_MIN_INTERVAL_MS = 15 * 60 * 1000
const CANARY_MAX_DIALS = 3

let log = createLogger('canary-probe')
let getDht = () => null
let onResult = () => {}
let timers = createTimers()

const freshState = () => ({
  result: { state: CANARY.UNAVAILABLE, at: 0 },
  probedAt: 0,
  inFlight: null,
  firstProbeTimer: null,
})
let state = freshState()

export function initCanaryProbe(deps) {
  if (deps.log) log = deps.log
  getDht = deps.getDht
  onResult = deps.onResult
}

export function canarySnapshot() {
  return state.result
}

function parseUpgradeKey(raw) {
  if (typeof raw !== 'string' || raw.length === 0) return null
  const bare = raw.replace(/^pear:\/\//, '').split('/')[0].trim()
  if (!bare) return null
  try {
    const key = idEncoding.decode(bare)
    return key.byteLength === 32 ? key : null
  } catch { return null }
}

/** @internal */
export function dialOnce(dht, peer) {
  return new Promise((resolve) => {
    let socket = null
    let settled = false
    const finish = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(deadline)
      if (socket) { try { socket.destroy() } catch {} }
      resolve(ok)
    }
    const deadline = setTimeout(() => finish(false), CANARY_TIMEOUT_MS)
    deadline.unref?.()
    try {
      // Explicit ephemeral identity: without opts.keyPair hyperdht dials with dht.defaultKeyPair,
      // which under a private relay is a durable member identity handed to the vendor's seeder.
      socket = dht.connect(peer.publicKey, {
        relayAddresses: peer.relayAddresses,
        keyPair: crypto.keyPair(),
      })
      socket.on('open', () => finish(true))
      socket.on('error', () => finish(false))
      socket.on('close', () => finish(false))
    } catch (err) {
      log.debug('canary dial threw:', err.message)
      finish(false)
    }
  })
}

async function collectAnnouncers(dht, topic) {
  const found = []
  const stream = dht.lookup(topic)
  const deadline = setTimeout(() => { try { stream.destroy() } catch {} }, CANARY_TIMEOUT_MS)
  deadline.unref?.()
  try {
    for await (const reply of stream) {
      for (const peer of reply.peers || []) {
        if (found.length >= CANARY_MAX_DIALS) return found
        found.push(peer)
      }
    }
  } catch (err) {
    log.debug('canary lookup failed:', err.message)
  } finally {
    clearTimeout(deadline)
    try { stream.destroy() } catch {}
  }
  return found
}

async function runCanaryProbe(upgradeKey) {
  const driveKey = parseUpgradeKey(upgradeKey)
  if (!driveKey) return { state: CANARY.UNAVAILABLE, reason: 'no-key' }
  const dht = getDht()
  if (!dht) return { state: CANARY.UNAVAILABLE, reason: 'no-dht' }

  const stage1Started = Date.now()
  const found = await collectAnnouncers(dht, crypto.discoveryKey(driveKey))
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

export async function probeCanary(upgradeKey, { force = false } = {}) {
  if (!force) {
    if (Date.now() - state.probedAt < CANARY_MIN_INTERVAL_MS) return state.result
    if (state.inFlight) return state.inFlight
  }

  // Identity-guarded on every arm: a forced probe replaces this one while it is still running, and
  // the two can settle in either order. Only the probe that still holds the slot may write, or the
  // older verdict would land last, carry the later timestamp, and be served by the freshness gate
  // above for the next quarter of an hour.
  const stale = () => state.inFlight !== probe
  const probe = runCanaryProbe(upgradeKey)
    .then((result) => {
      if (stale()) return state.result
      state.result = { ...result, at: Date.now() }
      state.probedAt = state.result.at
      onResult()
      return state.result
    })
    .catch((err) => {
      log.debug('canary probe failed:', err.message)
      if (stale()) return state.result
      state.result = { state: CANARY.UNAVAILABLE, at: Date.now() }
      return state.result
    })
    .finally(() => { if (!stale()) state.inFlight = null })
  state.inFlight = probe

  return probe
}

// A user with no spaces has only the NAT shape to go on, which is a prediction; one automatic
// probe after the NAT settles turns it into a measurement. Once per swarm, never on a timer: every
// other probe is user-initiated.
export function scheduleFirstCanaryProbe() {
  if (state.firstProbeTimer || spaceTopics.size > 0) return
  state.firstProbeTimer = timers.setTimeout(() => {
    state.firstProbeTimer = null
    if (spaceTopics.size > 0) return
    probeCanary(getUpgradeKey()).catch((err) => log.debug('first canary probe failed:', err.message))
  }, NAT_SETTLE_MS)
}

export function resetCanaryProbe() {
  timers.close()
  timers = createTimers()
  state = freshState()
}
