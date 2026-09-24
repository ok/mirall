// The live set of control-plane connections that currently run through a blind relay, keyed by
// socket. An entry exists from the moment the observer saw the stream paired through a relay until
// the stream closes or hyperdht moves it to a direct path. The relay's provenance and the relay mode
// in effect are decided once, at pairing time, so a later change to the configured relay or mode
// cannot relabel a connection that is still running through the old one. Whether the slot still
// names that relay is the opposite kind of fact and is read at snapshot time, as are names, resolved
// through the registry so a pre-handshake socket or a renamed peer never leaves a stale string here.
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import { relayPairingFor, isStillRelayed } from './relay-observe.js'

let ownRelay = () => ({ key: null, label: null, live: false })
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

// A relay is ours when this side supplied it — hyperdht pairs as the blind-relay initiator exactly
// when the key came from our own relayThrough (Server._relayConnection, relayConnection in
// connect.js) — or when the peer named the key we are live on, which happens when both sides
// configured the same relay. A key we are not live on is the peer's choice whatever the slot says:
// with the mode off we offered nothing.
export function relayVia(pairing, own) {
  if (!pairing.adopted) return 'own'
  return own.live && sameRelayKey(pairing.relayKey, own.key) ? 'own' : 'adopted'
}

function sameRelayKey(a, b) {
  return !!a && !!b && b4a.equals(a, b)
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
  const via = relayVia(pairing, own)
  const entry = {
    plane,
    memberOf,
    relayKey: pairing.relayKey,
    via,
    supplied: !pairing.adopted,
    relayLabel: via === 'own' && sameRelayKey(pairing.relayKey, own.key) ? own.label || null : null,
    // Read when the swarm reports the connection, after the relay was already chosen: a dial in
    // flight across a mode change carries the new mode.
    relayMode: relayMode(),
    since: now,
  }
  entries.set(socket, entry)
  relayedSeen++
  const unrelay = () => {
    const current = entries.get(socket)
    if (!current) return
    // Resolved before the delete: memberOf lives on the entry, and the consumer of this edge has to
    // know whose rows changed.
    const member = current.memberOf(socket)
    entries.delete(socket)
    onUnrelayed(socket, member)
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

// Whether this socket currently runs through a relay. Asked per person, over every socket bound to
// that person, so the answer carries no identity of its own.
export function isRelayedSocket(socket) {
  return entries.has(socket)
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
    supplied: entry.supplied,
    relayKey: idEncoding.encode(entry.relayKey),
    relayLabel: entry.relayLabel,
    relayMode: entry.relayMode,
    replaced: entry.via === 'own' && !sameRelayKey(entry.relayKey, ownRelay().key),
    since: entry.since,
  }
}

export function snapshotRelayedConnections() {
  const connections = []
  for (const socket of entries.keys()) {
    const { noiseKey, personKey, plane, displayName, via, supplied, relayKey, relayMode, replaced, since } = describeConnection(socket)
    connections.push({ noiseKey, personKey, plane, displayName, via, supplied, relayKey, relayMode, replaced, since })
  }
  const digest = connections.map((c) => `${c.noiseKey}:${c.personKey ?? ''}:${c.plane}:${c.relayKey}:${c.via}:${c.relayMode}:${c.replaced ? 1 : 0}:${c.supplied ? 1 : 0}:${c.displayName ?? ''}`).join('|')
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
  ownRelay = () => ({ key: null, label: null, live: false })
  relayMode = () => 'off'
  onChange = () => {}
  onRelayed = () => {}
  onUnrelayed = () => {}
}
