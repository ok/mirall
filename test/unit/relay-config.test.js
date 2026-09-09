import test from 'brittle'
import b4a from 'b4a'
import idEncoding from 'hypercore-id-encoding'
import { decodeRelayKey, enabledRelayKeys, relayFunctionFor, relayIdentityKeyPair } from '../../src/shared/transfer/relay.js'
import { isValidRelayKey, normalizeRelayMode, sanitizeRelay, MAX_LABEL_LENGTH } from '../../src/main/relay-keys.js'

const KEY_A = idEncoding.encode(b4a.alloc(32, 1))
const KEY_B = idEncoding.encode(b4a.alloc(32, 2))
const SEED_HEX = '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e'
const MEMBER_KEY = 'mrgq43jtgdacci91sdt9fxogdzc7wxtcu71mqi45sgf6e61p3rxy'

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

test('one slot in, one key out', (t) => {
  const keys = enabledRelayKeys({ publicKey: KEY_A, enabled: true })
  t.is(keys.length, 1)
  t.ok(b4a.equals(keys[0], b4a.alloc(32, 1)))

  t.is(enabledRelayKeys({ publicKey: KEY_A, enabled: false }).length, 0, 'a disabled relay is not a relay')
  t.is(enabledRelayKeys({ publicKey: 'garbage', enabled: true }).length, 0)
  t.is(enabledRelayKeys(null).length, 0)
  t.is(enabledRelayKeys(undefined).length, 0)
})

test('the relay identity follows the input, not the config', (t) => {
  // No seed → a fresh key per boot, the right identity for an open relay: one that admits
  // everyone has no business holding a durable name for us.
  t.absent(b4a.equals(relayIdentityKeyPair(null).publicKey, relayIdentityKeyPair(null).publicKey))
  t.absent(b4a.equals(relayIdentityKeyPair('nonsense').publicKey, relayIdentityKeyPair('nonsense').publicKey))
  t.absent(b4a.equals(relayIdentityKeyPair(SEED_HEX.toUpperCase()).publicKey, relayIdentityKeyPair(SEED_HEX).publicKey))

  // Stable across calls AND equal to the key the operator's roster holds — the whole
  // membership model rests on these being the same 32 bytes.
  t.alike(relayIdentityKeyPair(SEED_HEX).publicKey, relayIdentityKeyPair(SEED_HEX).publicKey)
  t.is(idEncoding.encode(relayIdentityKeyPair(SEED_HEX).publicKey), MEMBER_KEY)
})

test('relay mode maps onto hyperswarm semantics', (t) => {
  const keys = enabledRelayKeys({ publicKey: KEY_A, enabled: true })

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

// The two call shapes are a hyperdht/hyperswarm calling convention, not a declared API:
// every DIAL passes peerInfo.forceRelaying (a boolean, seeded false in peer-info.js:28),
// and the ANNOUNCE path arrives through selectRelay(this.relayThrough) with no arguments
// at all (server.js:354). If a future bump starts passing false on announce, offering
// silently stops and one-sided setups get slow again — this is the test that catches it.
test('auto offers our relay on the announce path even when it would not use one', (t) => {
  const keys = enabledRelayKeys({ publicKey: KEY_A, enabled: true })
  const auto = relayFunctionFor(keys, 'auto')

  t.is(auto(), keys, 'no arguments at all is the announce path — always offer')
  t.is(auto(undefined, { dht: { randomized: false } }), keys, 'offered regardless of our own NAT')
  t.is(auto(false, { dht: { randomized: false } }), null, 'a dial with force=false still declines')
})

// relaying.selected means "we put a relay in play", and it drives the network diagnostics.
// Counting the announce offer would make it climb on every inbound connection, most of
// which punch straight through and never touch a relay. hyperdht's own relaying.attempts
// counts the offers actually taken up (server.js:630).
test('offering on announce does not inflate the selected counter', (t) => {
  let selected = 0
  const keys = enabledRelayKeys({ publicKey: KEY_A, enabled: true })
  const auto = relayFunctionFor(keys, 'auto', () => { selected++ })

  auto()
  auto(undefined, { dht: { randomized: false } })
  t.is(selected, 0, 'an offer is not a selection')

  auto(true, { dht: { randomized: false } })
  t.is(selected, 1, 'a forced dial still counts')

  const always = relayFunctionFor(keys, 'always', () => { selected++ })
  always()
  t.is(selected, 2, 'always counts every call, announce included')
})

test('a private relay is used but never offered to strangers', (t) => {
  const keys = enabledRelayKeys({ publicKey: KEY_A, kind: 'private', enabled: true })
  const priv = relayFunctionFor(keys, 'auto', null, { offerable: false })

  // The announce path: a peer that adopts this key is not on the roster, so the relay
  // refuses it during the handshake and it cannot tell that from the relay being offline.
  t.is(priv(), null, 'not offered on announce')
  t.is(priv(undefined, { dht: { randomized: false } }), null)
  // Our own dials still use it — we ARE a member.
  t.is(priv(true, { dht: { randomized: false } }), keys, 'still used when forced')
  t.is(priv(false, { dht: { randomized: true } }), keys, 'still used on a randomized NAT')

  t.is(relayFunctionFor(keys, 'auto', null, { offerable: true })(), keys, 'an open relay is offered')
  t.is(relayFunctionFor(keys, 'auto')(), keys, 'offerable defaults to true')
})

// REGRESSION (FIX-1: the offerable guard lived only in the `auto` branch, so `always` — the mode
// reachable from the toggle sitting directly under the relay — returned `select` unconditionally
// and handed a roster-only relay to every peer that dialled us.)
test('REGRESSION (FIX-1: always honours offerable too)', (t) => {
  let selected = 0
  const keys = enabledRelayKeys({ publicKey: KEY_A, kind: 'private', enabled: true })
  const priv = relayFunctionFor(keys, 'always', () => { selected++ }, { offerable: false })

  t.is(priv(), null, 'the announce path withholds a private relay under always, as under auto')
  t.is(selected, 0, 'and withholding is not a selection')
  // Withholding costs nothing between members: hyperdht relays the connection when EITHER side
  // supplies a relay (server.js:402), and a private relay only works when both ends are members.
  t.is(priv(true, {}), keys, 'our own dials still use it')
  t.is(selected, 1)

  t.is(relayFunctionFor(keys, 'always')(), keys, 'an open relay is still offered on announce')
})

test('an unknown mode degrades to off', (t) => {
  t.is(normalizeRelayMode('nonsense'), 'off')
  t.is(normalizeRelayMode(undefined), 'off')
  t.is(normalizeRelayMode('auto'), 'auto')
  t.is(normalizeRelayMode('always'), 'always')
  t.is(relayFunctionFor(enabledRelayKeys({ publicKey: KEY_A, enabled: true }), 'nonsense'), null)
})

test('sanitizeRelay drops an undecodable slot rather than storing it', (t) => {
  t.is(sanitizeRelay({ publicKey: 'garbage' }), null)
  t.is(sanitizeRelay(null), null)
  t.is(sanitizeRelay([{ publicKey: KEY_A }]), null, 'an array is not a slot')
  t.is(sanitizeRelay('nope'), null)

  const slot = sanitizeRelay({ publicKey: KEY_B, kind: 'wat', label: 'x'.repeat(200) })
  t.is(slot.publicKey, KEY_B)
  t.is(slot.kind, 'open', 'an unknown kind degrades to open, never to private')
  t.is(slot.label.length, MAX_LABEL_LENGTH)
  t.is(slot.enabled, true, 'enabled defaults on')
  t.is(slot.lastTest, null)
  t.is(sanitizeRelay({ publicKey: KEY_B, kind: 'private' }).kind, 'private')
})

test('a malformed lastTest is dropped rather than trusted', (t) => {
  t.is(sanitizeRelay({ publicKey: KEY_A, lastTest: { at: 'soon', ok: true } }).lastTest, null)
  t.alike(sanitizeRelay({ publicKey: KEY_A, lastTest: { at: 5, ok: false } }).lastTest, { at: 5, ok: false })
})
