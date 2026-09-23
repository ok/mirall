import test from 'brittle'
import b4a from 'b4a'
import Hypercore from 'hypercore'
import { deriveKeyPair, deriveParticipationKeyPair, deriveParticipationId, participationName } from '../../src/shared/core/identity-keys.js'

const M = b4a.from('22'.repeat(32), 'hex')
const OTHER = b4a.from('33'.repeat(32), 'hex')

test('deriveKeyPair is deterministic and name-scoped', (t) => {
  t.alike(deriveKeyPair(M, 'profile').publicKey, deriveKeyPair(M, 'profile').publicKey, 'same name → same key')
  t.unlike(deriveKeyPair(M, 'profile').publicKey, deriveKeyPair(M, 'spaces-meta').publicKey, 'different name → different key')
  t.unlike(deriveKeyPair(M, 'profile').publicKey, deriveKeyPair(OTHER, 'profile').publicKey, 'different master → different key')
})

test('the participation name carries the suffix, and a record without one keeps the plain name', (t) => {
  t.is(participationName('abc', 'ff00'), 'space-drive-abc-ff00')
  t.is(participationName('abc', undefined), 'space-drive-abc')
})

test('deriveParticipationKeyPair is deterministic and scoped to space and participation', (t) => {
  const kp = (m, id, sfx) => deriveParticipationKeyPair(m, id, sfx).publicKey
  t.alike(kp(M, 'a', 's1'), kp(M, 'a', 's1'), 'same participation → same key')
  t.unlike(kp(M, 'a', 's1'), kp(M, 'b', 's1'), 'different space → different key')
  t.unlike(kp(M, 'a', 's1'), kp(M, 'a', 's2'), 'a rejoin (new suffix) → different key')
  t.unlike(kp(M, 'a', 's1'), kp(OTHER, 'a', 's1'), 'different master → different key')
  t.unlike(kp(M, 'a', null), deriveKeyPair(M, 'db').publicKey, 'participation key ≠ root-namespace db key')
})

test('the participation id is the core key of the participation key pair', (t) => {
  const kp = deriveParticipationKeyPair(M, 'a', 's1')
  t.alike(deriveParticipationId(M, 'a', 's1'), Hypercore.key(kp.publicKey))
  t.is(deriveParticipationId(M, 'a', 's1').length, 32)
})
