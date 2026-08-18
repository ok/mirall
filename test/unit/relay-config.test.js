import test from 'brittle'
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import { decodeRelayKey, enabledRelayKeys, relayFunctionFor } from '../../src/shared/transfer/relay.js'
import { isValidRelayKey, normalizeRelayMode, sanitizeRelays, MAX_RELAYS } from '../../src/main/relay-keys.js'

const KEY_A = idEncoding.encode(b4a.alloc(32, 1))
const KEY_B = idEncoding.encode(b4a.alloc(32, 2))

test('a relay key must decode to exactly 32 bytes', (t) => {
  t.is(decodeRelayKey(KEY_A)?.byteLength, 32)
  t.is(decodeRelayKey(b4a.toString(b4a.alloc(32, 3), 'hex'))?.byteLength, 32, 'hex form is accepted')

  t.is(decodeRelayKey(KEY_A.slice(0, 51)), null, 'truncated')
  t.is(decodeRelayKey(`${KEY_A} `), null, 'trailing space')
  t.is(decodeRelayKey(KEY_A.toUpperCase()), null, 'wrong case is not z-base-32')
  t.is(decodeRelayKey('lv0000000000000000000000000000000000000000000000000v'), null, 'non-z32 characters')
  t.is(decodeRelayKey(''), null)
  t.is(decodeRelayKey(null), null)
  t.is(decodeRelayKey(42), null)
})

test('main and worker agree on what a valid key is', (t) => {
  for (const value of [KEY_A, KEY_A.slice(0, 51), '', null, 42, 'not-a-key']) {
    t.is(isValidRelayKey(value), decodeRelayKey(value) !== null, `agree on ${String(value).slice(0, 12)}`)
  }
})

test('only enabled relays are handed to hyperswarm', (t) => {
  const keys = enabledRelayKeys([
    { publicKey: KEY_A, enabled: true },
    { publicKey: KEY_B, enabled: false },
    { publicKey: 'garbage', enabled: true },
    null,
  ])
  t.is(keys.length, 1)
  t.ok(b4a.equals(keys[0], b4a.alloc(32, 1)))
  t.is(enabledRelayKeys(null).length, 0)
})

test('relay mode maps onto hyperswarm semantics', (t) => {
  const keys = enabledRelayKeys([{ publicKey: KEY_A, enabled: true }])

  t.is(relayFunctionFor(keys, 'off'), null, 'off installs no function at all')
  t.is(relayFunctionFor([], 'always'), null, 'no keys means no function')
  t.is(relayFunctionFor([], 'auto'), null)

  const always = relayFunctionFor(keys, 'always')
  t.is(always(false, { dht: { randomized: false } }), keys, 'always relays every connection')

  const auto = relayFunctionFor(keys, 'auto')
  t.is(auto(false, { dht: { randomized: false } }), null, 'auto stays off until a punch fails')
  t.is(auto(true, { dht: { randomized: false } }), keys, 'auto engages once forced')
  t.is(auto(false, { dht: { randomized: true } }), keys, 'auto engages up front on a randomized NAT')
  t.is(auto(false, {}), null, 'a swarm with no dht yet does not throw')
})

test('an unknown mode degrades to off', (t) => {
  t.is(normalizeRelayMode('nonsense'), 'off')
  t.is(normalizeRelayMode(undefined), 'off')
  t.is(normalizeRelayMode('auto'), 'auto')
  t.is(normalizeRelayMode('always'), 'always')
  t.is(relayFunctionFor(enabledRelayKeys([{ publicKey: KEY_A, enabled: true }]), 'nonsense'), null)
})

test('sanitizeRelays drops bad rows without losing the good ones', (t) => {
  const relays = sanitizeRelays([
    { id: 'a', label: 'A', publicKey: KEY_A, enabled: true, lastTest: { at: 1, ok: true } },
    { id: 'b', label: 'B', publicKey: 'garbage' },
    { id: 'c', publicKey: KEY_B },
    { publicKey: KEY_B },
    'nope',
    null,
  ])
  t.is(relays.length, 2, 'the two decodable, identified rows survive')
  t.is(relays[0].id, 'a')
  t.is(relays[1].id, 'c')
  t.is(relays[1].label, '', 'a missing label becomes empty, not undefined')
  t.is(relays[1].enabled, true, 'enabled defaults on')
  t.is(relays[1].lastTest, null)
})

test('sanitizeRelays collapses duplicate keys and bounds the list', (t) => {
  const dupes = sanitizeRelays([
    { id: 'first', publicKey: KEY_A },
    { id: 'second', publicKey: KEY_A },
  ])
  t.is(dupes.length, 1, 'one key cannot be applied twice')
  t.is(dupes[0].id, 'first')

  const many = []
  for (let i = 0; i < MAX_RELAYS + 5; i++) {
    const key = b4a.alloc(32, 0)
    key[0] = i + 1
    many.push({ id: `r${i}`, publicKey: idEncoding.encode(key) })
  }
  t.is(sanitizeRelays(many).length, MAX_RELAYS)
  t.is(sanitizeRelays('not an array').length, 0)
})

test('a malformed lastTest is dropped rather than trusted', (t) => {
  const [relay] = sanitizeRelays([{ id: 'a', publicKey: KEY_A, lastTest: { at: 'soon', ok: true } }])
  t.is(relay.lastTest, null)
  const [ok] = sanitizeRelays([{ id: 'a', publicKey: KEY_A, lastTest: { at: 5, ok: false } }])
  t.alike(ok.lastTest, { at: 5, ok: false })
})
