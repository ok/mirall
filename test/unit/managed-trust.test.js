import test from 'brittle'
import b4a from 'b4a'
import { PINNED_SIGNING_KEYS, hasManagedTrust } from '../../src/shared/contract/managed-trust.js'
import { pinnedKeysFor } from '../../src/shared/managed/trust.js'

test('every pinned key is a 32-byte hex Ed25519 key', (t) => {
  for (const [channel, keys] of Object.entries(PINNED_SIGNING_KEYS)) for (const key of keys) t.ok(/^[0-9a-f]{64}$/.test(key), `${channel}: ${key}`)
})

const PRODUCTION = ['3759cc93c535317e18e78d4b5682db34f71762fcb56bc05b17781942f16805f3', 'd81dcc0b0ce4780000bbbd268d87054731f0d57b2af730ef708e2878fc01b0d0']
const STAGING = '3b6bf0ebd153d0fabd9a1d61074756b20380f91ceddc692cd7507c46a4456a61'

test('trust per channel: production on prod, production and staging on beta, staging on dev', (t) => {
  t.alike([...PINNED_SIGNING_KEYS.prod], PRODUCTION)
  t.alike([...PINNED_SIGNING_KEYS.staging], [...PRODUCTION, STAGING])
  t.alike([...PINNED_SIGNING_KEYS.dev], [STAGING])
  for (const channel of ['prod', 'staging', 'dev']) t.ok(hasManagedTrust(channel), channel)
  t.absent(hasManagedTrust('nightly'))
})

test('a bundle names its signer by the key\'s first 8 bytes, so no channel holds two keys that share them', (t) => {
  for (const [channel, keys] of Object.entries(PINNED_SIGNING_KEYS)) {
    t.is(new Set(keys.map((key) => key.slice(0, 16))).size, keys.length, channel)
  }
})

test('the test lever adds one key, only when it is well formed', (t) => {
  const test = 'ab'.repeat(32)
  t.is(pinnedKeysFor('dev').length, 1)
  t.is(pinnedKeysFor('dev', { testKeyHex: test }).length, 2)
  t.is(b4a.toString(pinnedKeysFor('prod', { testKeyHex: test }).at(-1), 'hex'), test)
  t.is(pinnedKeysFor('dev', { testKeyHex: 'zz' }).length, 1)
})
