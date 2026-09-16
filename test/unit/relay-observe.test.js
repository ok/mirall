import test from 'brittle'
import { EventEmitter } from 'node:events'
import b4a from 'b4a'
import { installRelayObserver, resetRelayObserver, relayPairingFor, isStillRelayed } from '../../src/shared/network/relay-observe.js'

const RELAY_KEY = b4a.alloc(32, 7)

function relayStream({ host = '203.0.113.9', port = 49737 } = {}) {
  return { remotePublicKey: RELAY_KEY, rawStream: { remoteHost: host, remotePort: port } }
}

function stubClass() {
  const seenThis = []
  class Stub extends EventEmitter {
    static clients = new Map()
    static from(stream, opts) {
      seenThis.push(this)
      let client = Stub.clients.get(stream)
      if (!client) { client = new Stub(opts); Stub.clients.set(stream, client) }
      return client
    }
  }
  return { Stub, seenThis }
}

function withObserver(t) {
  const { Stub, seenThis } = stubClass()
  const original = Stub.from
  installRelayObserver({ Client: Stub })
  t.teardown(resetRelayObserver)
  return { Stub, seenThis, original }
}

test('install wraps Client.from once and reset restores the original', (t) => {
  const { Stub, original } = withObserver(t)
  t.not(Stub.from, original, 'wrapped')
  const wrapped = Stub.from
  installRelayObserver({ Client: Stub })
  t.is(Stub.from, wrapped, 'a second install is a no-op')
  resetRelayObserver()
  t.is(Stub.from, original, 'restored')
})

test('from is called with the class as this', (t) => {
  const { Stub, seenThis } = withObserver(t)
  Stub.from(relayStream(), { id: 'x' })
  t.is(seenThis[0], Stub)
})

test("a 'pair' event records relay key, adopted and the relay endpoint against the raw stream", (t) => {
  const { Stub } = withObserver(t)
  const stream = relayStream()
  const client = Stub.from(stream, {})
  const rawStream = {}
  client.emit('pair', false, b4a.alloc(4), rawStream, b4a.alloc(4))
  const pairing = relayPairingFor(rawStream)
  t.is(pairing.relayKey, RELAY_KEY)
  t.is(pairing.adopted, true)
  t.alike(pairing.relayEndpoint, { host: '203.0.113.9', port: 49737 })
})

test('isInitiator true reads as not adopted', (t) => {
  const { Stub } = withObserver(t)
  const client = Stub.from(relayStream(), {})
  const rawStream = {}
  client.emit('pair', true, b4a.alloc(4), rawStream, b4a.alloc(4))
  t.is(relayPairingFor(rawStream).adopted, false)
})

test('one client per stream is subscribed once', (t) => {
  const { Stub } = withObserver(t)
  const stream = relayStream()
  const client = Stub.from(stream, {})
  t.is(Stub.from(stream, {}), client)
  t.is(client.listenerCount('pair'), 1)
})

test("isStillRelayed compares the raw stream's remote endpoint with the relay's", (t) => {
  const endpoint = { host: '203.0.113.9', port: 49737 }
  t.ok(isStillRelayed({ remoteHost: '203.0.113.9', remotePort: 49737 }, endpoint))
  t.absent(isStillRelayed({ remoteHost: '198.51.100.4', remotePort: 49737 }, endpoint))
  t.absent(isStillRelayed({ remoteHost: '203.0.113.9', remotePort: 1 }, endpoint))
  t.absent(isStillRelayed({ remoteHost: '203.0.113.9', remotePort: 49737 }, null))
})

test('an unknown raw stream reads as direct', (t) => {
  withObserver(t)
  t.is(relayPairingFor({}), null)
  t.is(relayPairingFor(null), null)
})
