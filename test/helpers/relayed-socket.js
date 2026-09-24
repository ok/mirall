// The synthetic relayed socket the relay tests drive, shared by the unit and the integration tier
// so both observe the same fake. A real relayed pairing cannot be forced on loopback — hyperdht
// punches through — so the pairing is staged through relay-observe's own `Client.from` seam.
//
// The emitter is hand-rolled rather than imported: this file loads under plain Node (test/unit) and
// under Bare (test/integration), and the two disagree on which `events` module exists.
import b4a from 'b4a'

class Emitter {
  constructor() { this.listeners = new Map() }

  on(name, fn) {
    const forName = this.listeners.get(name) ?? []
    forName.push(fn)
    this.listeners.set(name, forName)
    return this
  }

  once(name, fn) {
    const wrapper = (...args) => { this.off(name, wrapper); fn(...args) }
    return this.on(name, wrapper)
  }

  off(name, fn) {
    const forName = this.listeners.get(name)
    const at = forName ? forName.indexOf(fn) : -1
    if (at >= 0) forName.splice(at, 1)
    return this
  }

  emit(name, ...args) {
    for (const fn of [...(this.listeners.get(name) ?? [])]) fn(...args)
  }
}

export const OWN = b4a.alloc(32, 1)
export const OTHER = b4a.alloc(32, 2)
export const PEER = b4a.alloc(32, 9)
const RELAY_ENDPOINT = { host: '203.0.113.9', port: 49737 }

// Stands in for blind-relay's Client: installRelayObserver wraps its static `from`, and the
// observer records a pairing when the instance emits 'pair'.
export class Stub extends Emitter {
  static from() { return new Stub() }
}

// A socket whose raw stream reads as paired through `relayKey`, or as direct when none is given.
// `adopted` flips which side offered the relay.
export function socketOf({ relayKey = null, adopted = false } = {}) {
  const rawStream = Object.assign(new Emitter(), { remoteHost: RELAY_ENDPOINT.host, remotePort: RELAY_ENDPOINT.port })
  const socket = Object.assign(new Emitter(), { remotePublicKey: PEER, rawStream, destroy() { this.emit('close') } })
  if (relayKey) {
    const client = Stub.from({ remotePublicKey: relayKey, rawStream: { remoteHost: RELAY_ENDPOINT.host, remotePort: RELAY_ENDPOINT.port } }, {})
    client.emit('pair', !adopted, b4a.alloc(4), rawStream, b4a.alloc(4))
  }
  return socket
}
