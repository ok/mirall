// Installing the blind relay onto the live swarms, and probing one.
//
// This is the impure third of the relay trio: relay.js holds the pure key and mode rules and
// relay-ticket.js the codec, both Node-testable. Installing needs Hyperswarm and the content
// swarm, so it lives apart from them rather than dragging their imports into a pure module.

import BlindRelay from 'blind-relay'
import { createLogger } from '../core/logger.js'
import { getRelayConfig } from '../core/runtime-config.js'
import { peerRelayed, peerUnrelayed } from '../audit/network-watch.js'
import { enabledRelayKeys, relayFunctionFor, decodeRelayKey } from './relay.js'
import { getContentSwarm } from './content-swarm.js'
import { installRelayObserver, resetRelayObserver } from './relay-observe.js'
import { initRelayedConnections, resetRelayedConnections, describeConnection } from './relayed-connections.js'

const log = createLogger('relay-install')

let getSwarm = () => null

export function initRelayInstall(deps) {
  getSwarm = deps.getSwarm
  installRelayObserver()
  initRelayedConnections({
    ownRelay,
    relayMode: () => getRelayConfig().mode,
    onChange: deps.onStatusChange,
    onRelayed: (socket) => peerRelayed(socket, () => describeConnection(socket)),
    onUnrelayed: peerUnrelayed,
  })
}

function ownRelay() {
  const { relay } = getRelayConfig()
  return { key: enabledRelayKeys(relay)[0] ?? null, label: relay?.label || null }
}

const RELAY_PROBE_TIMEOUT_MS = 10000

// hyperdht increments dht.stats.relaying only on its ANNOUNCE path (Server._relayConnection);
// the dialing side is never counted. Since the relay function is ours, counting its
// selections is the one signal that covers both directions — without it the diagnostics
// read 0 on the peer doing the relaying, which is precisely the peer checking.
let relaySelections = 0
// Whether this node actually booted with a pinned member identity. A config that names a private
// relay is not proof: the vault can be missing (a machine move that copied config.json but not
// relay-ticket.enc) or unreadable under a new keyring, and readRelaySeedHex degrades to null.
let relayIdentityPinned = false

// BOTH swarms, always. The content plane carries every file byte, so configuring only
// the control swarm produces a build whose handshakes connect and whose transfers stall.
// Call this after the ContentSwarm subsystem has started — getContentSwarm() is null until its
// _open runs, which is why boot.js applies the relay config only once both swarms are up.
export function setRelayThrough(relay, mode) {
  // A private relay names a member the firewall matches by key. Without the seed live on this
  // node we present a different key, so installing it would route every dial into a refusal
  // instead of letting it fall back to a direct connection — the silent-never-connects failure
  // the ticket format exists to prevent. Refuse loudly and stay direct.
  const identityMissing = relay?.kind === 'private' && !relayIdentityPinned
  if (identityMissing) log.warn('relay: a private relay is configured but no member identity is live — not installing it')

  const keys = identityMissing ? [] : enabledRelayKeys(relay)
  const fn = relayFunctionFor(keys, mode, () => { relaySelections++ }, {
    offerable: relay?.kind !== 'private',
  })
  for (const s of [getSwarm(), getContentSwarm()]) {
    if (!s) continue
    s.relayThrough = fn
  }
  return identityMissing ? { applied: 0, reason: 'identity-missing' } : { applied: fn ? keys.length : 0 }
}

// A mistyped or stale key is otherwise invisible until a space silently fails to sync
// weeks later. Reaching the Noise stream only proves something answers on that key, so
// the verdict waits for the blind-relay protomux channel to open.
export async function testRelayReachable(publicKey) {
  const key = decodeRelayKey(publicKey)
  if (!key) return { ok: false, reason: 'invalid-key' }
  const dht = getSwarm()?.dht
  if (!dht) return { ok: false, reason: 'offline' }

  let socket = null
  let settle = null
  const verdict = new Promise((resolve) => { settle = resolve })
  const timer = setTimeout(() => settle({ ok: false, reason: 'timeout' }), RELAY_PROBE_TIMEOUT_MS)
  timer.unref?.()

  try {
    socket = dht.connect(key)
    socket.on('error', () => settle({ ok: false, reason: 'unreachable' }))
    socket.on('close', () => settle({ ok: false, reason: 'unreachable' }))
    const client = BlindRelay.Client.from(socket, { id: socket.publicKey })
    // 'open' fires when the remote opens ITS side of the blind-relay channel, which is
    // what distinguishes a relay from any other reachable hyperdht node. The Client
    // class emits only open/close/destroy/pair — it has no 'error' event — so a peer
    // that answers but speaks no blind-relay is caught by close/destroy or the timeout.
    client.on('open', () => settle({ ok: true }))
    client.on('close', () => settle({ ok: false, reason: 'not-a-relay' }))
    client.on('destroy', () => settle({ ok: false, reason: 'not-a-relay' }))
  } catch (err) {
    log.debug('relay probe failed:', err.message)
    settle({ ok: false, reason: 'unreachable' })
  }

  const result = await verdict
  clearTimeout(timer)
  if (socket) { try { socket.destroy() } catch {} }
  return result
}

// Whether this node booted with a pinned member identity. Set from the seed the DHT key pair was
// derived from, because a config naming a private relay is not proof: the vault can be missing (a
// machine move that copied config.json but not relay-ticket.enc) or unreadable under a new
// keyring, and readRelaySeedHex degrades to null.
export function pinRelayIdentity(relaySeedHex) {
  relayIdentityPinned = typeof relaySeedHex === 'string' && relaySeedHex.length > 0
}

export function relaySelectionCount() {
  return relaySelections
}

export function resetRelayInstall() {
  relaySelections = 0
  relayIdentityPinned = false
  resetRelayedConnections()
  resetRelayObserver()
}
