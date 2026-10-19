import test from 'brittle'
import b4a from 'b4a'
import { PINNED_SIGNING_KEYS, hasManagedTrust } from '../../src/shared/contract/managed-trust.js'
import { pinnedKeysFor } from '../../src/shared/managed/trust.js'

test('every pinned key is a 32-byte hex Ed25519 key', (t) => {
  for (const [channel, keys] of Object.entries(PINNED_SIGNING_KEYS)) for (const key of keys) t.ok(/^[0-9a-f]{64}$/.test(key), `${channel}: ${key}`)
})

test('trust per channel: none on prod until its keys exist', (t) => {
  t.absent(hasManagedTrust('prod'))
  t.ok(hasManagedTrust('staging'))
  t.ok(hasManagedTrust('dev'))
  t.absent(hasManagedTrust('nightly'))
})

test('the test lever adds one key, only when it is well formed', (t) => {
  const test = 'ab'.repeat(32)
  t.is(pinnedKeysFor('staging').length, 1)
  t.is(pinnedKeysFor('staging', { testKeyHex: test }).length, 2)
  t.is(b4a.toString(pinnedKeysFor('prod', { testKeyHex: test })[0], 'hex'), test)
  t.is(pinnedKeysFor('staging', { testKeyHex: 'zz' }).length, 1)
})
