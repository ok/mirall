import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { dialOnce } from '../../src/shared/transfer/connectivity.js'

function deadSocket() {
  const handlers = {}
  return {
    on(event, fn) { handlers[event] = fn; if (event === 'close') queueMicrotask(fn) },
    destroy() {},
  }
}

// REGRESSION: dialOnce passed no keypair, so hyperdht dialled the vendor's update seeder with
// dht.defaultKeyPair (connect.js:47). Harmless while that key was random per boot; under a
// private relay it is a durable club identity, and handing it to a third party is exactly what
// the invite model must not do.
test('the canary presents an ephemeral key, never the node identity', async (t) => {
  const nodeKeyPair = crypto.keyPair()
  const seen = []
  const dht = {
    defaultKeyPair: nodeKeyPair,
    connect(key, opts) { seen.push(opts); return deadSocket() },
  }
  const peer = { publicKey: b4a.alloc(32, 3), relayAddresses: [] }

  await dialOnce(dht, peer)
  await dialOnce(dht, peer)

  t.is(seen.length, 2)
  t.ok(seen[0].keyPair, 'an explicit keypair is passed; without one hyperdht uses defaultKeyPair')
  t.is(seen[0].keyPair.publicKey.byteLength, 32)
  t.absent(b4a.equals(seen[0].keyPair.publicKey, nodeKeyPair.publicKey),
    'the update seeder must never learn our relay membership')
  t.absent(b4a.equals(seen[0].keyPair.publicKey, seen[1].keyPair.publicKey), 'and a fresh one per dial')
  t.alike(seen[0].relayAddresses, [], 'the existing option still rides along')
})
