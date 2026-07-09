import test from 'brittle'
import b4a from 'b4a'
import { deriveContentKey, deriveKeyPair, deriveDriveKeyPair } from '../../src/shared/core/identity-keys.js'

const M = b4a.from('11'.repeat(32), 'hex')

test('deriveContentKey is deterministic and label-scoped', (t) => {
  t.alike(deriveContentKey(M, 'space-content/abc'), deriveContentKey(M, 'space-content/abc'))
  t.unlike(deriveContentKey(M, 'space-content/abc'), deriveContentKey(M, 'space-content/def'))
  t.is(deriveContentKey(M, 'x').length, 32)
})

test('content keys are domain-separated from signing seeds', (t) => {
  const ck = deriveContentKey(M, 'db')
  t.unlike(ck, deriveKeyPair(M, 'db').publicKey)
  t.unlike(ck, deriveDriveKeyPair(M, 'db').publicKey)
})

test('different M yields a different content key', (t) => {
  t.unlike(deriveContentKey(M, 'k'), deriveContentKey(b4a.from('22'.repeat(32), 'hex'), 'k'))
})
