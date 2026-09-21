// The live set of control-plane connections that currently run through a blind relay, keyed by
// socket. An entry exists from the moment the observer saw the stream paired through a relay until
// the stream closes or hyperdht moves it to a direct path. The relay's provenance and the relay mode
// in effect are decided once, at pairing time, so a later change to the configured relay or mode
// cannot relabel a connection that is still running through the old one. Names are resolved at
// snapshot time through the registry so a pre-handshake socket or a renamed peer never leaves a
// stale string here.
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import { relayPairingFor, isStillRelayed } from './relay-observe.js'

let ownRelay = () => ({ key: null, label: null })
let relayMode = () => 'off'
let onChange = () => {}
let onRelayed = () => {}
let onUnrelayed = () => {}

const entries = new Map()
const direct = new Map()
let relayedSeen = 0

export function initRelayedConnections(deps) {
  ownRelay = deps.ownRelay
  relayMode = deps.relayMode ?? (() => 'off')
  onChange = deps.onChange
  onRelayed = deps.onRelayed ?? (() => {})
  onUnrelayed = deps.onUnrelayed ?? (() => {})
}

// 'own' is decided by key equality, not by the initiator flag: a peer can hand our own key back
// to us in its payload, and that connection still runs through our relay.
export function relayVia(relayKey, own) {
  return own && b4a.equals(relayKey, own) ? 'own' : 'adopted'
}

export function trackConnection(socket, { plane, memberOf, now = Date.now() }) {
  const pairing = relayPairingFor(socket.rawStream)
  if (!pairing) {
    // Emitted like a relayed one: only the control swarm has an 'update' watcher, so without this a
    // direct connection on the content plane reaches the frame whenever something unrelated fires.
    direct.set(socket, plane)
    socket.once('close', () => { direct.delete(socket); onChange() })
    onChange()
    return null
  }
  const own = ownRelay()
  const via = relayVia(pairing.relayKey, own.key)
  const entry = {
    plane,
    memberOf,
    relayKey: pairing.relayKey,
    via,
    relayLabel: via === 'own' ? own.label || null : null,
    // Read when the swarm reports the connection, after the relay was already chosen: a dial in
    // flight across a mode change carries the new mode.
    relayMode: relayMode(),
    since: now,
  }
  entries.set(socket, entry)
  relayedSeen++
  const unrelay = () => {
    if (!entries.delete(socket)) return
    onUnrelayed(socket)
    onChange()
  }
  socket.rawStream.on('remote-changed', () => {
    if (isStillRelayed(socket.rawStream, pairing.relayEndpoint)) return
    direct.set(socket, plane)
    unrelay()
  })
  socket.once('close', () => {
    direct.delete(socket)
    unrelay()
  })
  onRelayed(socket)
  onChange()
  return entry
}

export function describeConnection(socket) {
  const entry = entries.get(socket)
  if (!entry) return null
  const member = entry.memberOf(socket)
  return {
    noiseKey: b4a.toString(socket.remotePublicKey, 'hex'),
    plane: entry.plane,
    personKey: member?.profileKey ?? null,
    displayName: member?.displayName ?? null,
    via: entry.via,
    relayKey: idEncoding.encode(entry.relayKey),
    relayLabel: entry.relayLabel,
    relayMode: entry.relayMode,
    since: entry.since,
  }
}

export function snapshotRelayedConnections() {
  const connections = []
  for (const socket of entries.keys()) {
    const { noiseKey, personKey, plane, displayName, via, relayKey, relayMode, since } = describeConnection(socket)
    connections.push({ noiseKey, personKey, plane, displayName, via, relayKey, relayMode, since })
  }
  const digest = connections.map((c) => `${c.noiseKey}:${c.personKey ?? ''}:${c.plane}:${c.relayKey}:${c.via}:${c.relayMode}:${c.displayName ?? ''}`).join('|')
  return { connections, direct: directCounts(), seen: relayedSeen, digest }
}

function directCounts() {
  const counts = { control: 0, content: 0 }
  for (const plane of direct.values()) counts[plane]++
  return counts
}

export function resetRelayedConnections() {
  entries.clear()
  direct.clear()
  relayedSeen = 0
  ownRelay = () => ({ key: null, label: null })
  relayMode = () => 'off'
  onChange = () => {}
  onRelayed = () => {}
  onUnrelayed = () => {}
}
