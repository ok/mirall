import test from 'brittle'
import b4a from 'b4a'
import { deriveKeyPair, deriveDriveKeyPair } from '../../src/shared/core/identity-keys.js'

const M = b4a.from('22'.repeat(32), 'hex')
const OTHER = b4a.from('33'.repeat(32), 'hex')

test('deriveKeyPair is deterministic and name-scoped', (t) => {
  t.alike(deriveKeyPair(M, 'profile').publicKey, deriveKeyPair(M, 'profile').publicKey, 'same name → same key')
  t.unlike(deriveKeyPair(M, 'profile').publicKey, deriveKeyPair(M, 'spaces-meta').publicKey, 'different name → different key')
  t.unlike(deriveKeyPair(M, 'profile').publicKey, deriveKeyPair(OTHER, 'profile').publicKey, 'different master → different key')
})

test('deriveDriveKeyPair is deterministic and drive-scoped', (t) => {
  t.alike(deriveDriveKeyPair(M, 'space-drive-a').publicKey, deriveDriveKeyPair(M, 'space-drive-a').publicKey, 'same drive → same key')
  t.unlike(deriveDriveKeyPair(M, 'space-drive-a').publicKey, deriveDriveKeyPair(M, 'space-drive-b').publicKey, 'different drive → different key')
  t.unlike(deriveDriveKeyPair(M, 'space-drive-a').publicKey, deriveKeyPair(M, 'db').publicKey, 'drive db key ≠ root-namespace db key')
})
