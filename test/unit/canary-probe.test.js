import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import idEncoding from 'hypercore-id-encoding'
import {
  initCanaryProbe, resetCanaryProbe, probeCanary, dialOnce, canarySnapshot,
} from '../../src/shared/network/canary-probe.js'

const delay = (ms) => new Promise((r) => setTimeout(r, ms))
const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

function deadSocket() {
  const handlers = {}
  return {
    on(event, fn) { handlers[event] = fn; if (event === 'close') queueMicrotask(fn) },
    destroy() {},
  }
}

// A DHT lookup we can hold open. The probe iterates the stream to collect announce records, so a
// stream that yields nothing until released is a probe parked in its first stage.
function heldLookup() {
  let release = null
  const closed = new Promise((resolve) => { release = resolve })
  return {
    release: () => release(),
    destroy() { release() },
    async * [Symbol.asyncIterator]() { await closed },
  }
}

const emptyLookup = () => ({ destroy() {}, async * [Symbol.asyncIterator]() {} })

function canary(t, lookups, { onResult = () => {} } = {}) {
  const dht = { lookup: () => lookups.shift() }
  initCanaryProbe({ log: silentLog, getDht: () => dht, onResult })
  t.teardown(() => resetCanaryProbe())
}

// REGRESSION: dialOnce passed no keypair, so hyperdht dialled the vendor's update seeder with
// dht.defaultKeyPair. Harmless while that key was random per boot; under a private relay it is a
// durable club identity, and handing it to a third party is exactly what the invite model must not do.
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

test('an unparseable upgrade key is unavailable, not an outage', async (t) => {
  canary(t, [])
  t.alike(await probeCanary('not-a-key', { force: true }), { ...canarySnapshot() })
  t.is(canarySnapshot().state, 'unavailable')
})

test('no announce record means the seeder is down, and the result is latched', async (t) => {
  let results = 0
  canary(t, [emptyLookup()], { onResult: () => results++ })
  const key = idEncoding.encode(crypto.randomBytes(32))
  const first = await probeCanary(key, { force: true })
  t.is(first.state, 'seeder-down')
  t.is(first.stage1.announceRecords, 0)
  t.is(results, 1, 'the owner is told once per settled probe')
  t.is(await probeCanary(key), first, 'an unforced probe inside the freshness window is served from the latch')
})

// REGRESSION: only the in-flight HANDLE was identity-guarded. The two result-writing arms were not,
// so when a forced probe overtook a slow one, the slow one's verdict landed afterwards — overwriting
// the newer answer AND stamping it with a later timestamp. The freshness gate then served that stale
// verdict to every caller for another quarter of an hour, and it is what the renderer shows.
test('REGRESSION (FIX-CANARY-STALE-RESULT): a slow probe that settles last does not overwrite the newer verdict',
  async (t) => {
    const held = heldLookup()
    canary(t, [held, emptyLookup()])
    const key = idEncoding.encode(crypto.randomBytes(32))

    // Both forced: `force` is what the user-triggered path passes, and it is the only way two
    // probes are ever in flight at once — which is the race the guard exists for.
    let slowSettled = false
    const slow = probeCanary(key, { force: true }).then((r) => { slowSettled = true; return r })
    await delay(5)
    const fast = await probeCanary(key, { force: true })
    t.ok(fast.stage1.ms < 60, 'the forced probe answered promptly')

    await delay(80)
    t.absent(slowSettled, 'the first probe is still parked, so it can only settle after the newer one')
    held.release()
    await slow

    const latest = await probeCanary(key)
    t.is(latest.stage1.ms, fast.stage1.ms,
      'the latched verdict is the newer probe\'s, not the stale one that finished last')
    t.ok(latest.stage1.ms < 60, 'and it carries the newer probe\'s timings, not an 80ms stage 1')
  })

test('a reset discards a probe still in flight', async (t) => {
  const held = heldLookup()
  canary(t, [held])
  const key = idEncoding.encode(crypto.randomBytes(32))
  const parked = probeCanary(key, { force: true })
  resetCanaryProbe()
  held.release()
  await parked
  t.alike(canarySnapshot(), { state: 'unavailable', at: 0 }, 'the fresh state is untouched by the old probe')
})
