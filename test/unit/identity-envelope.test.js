import test from 'brittle'
import b4a from 'b4a'
import { wrap, unwrap, seal, open, randomKEK, KEK_BYTES } from '../../src/shared/core/identity-envelope.js'

test('wrap/unwrap round-trips M with the right KEK, fails with the wrong one', (t) => {
  const M = b4a.from('11'.repeat(32), 'hex')
  const kek = randomKEK()
  const env = wrap(M, kek)
  t.alike(unwrap(env, kek), M, 'right KEK → recovers M')
  t.is(unwrap(env, randomKEK()), null, 'wrong KEK → null (AEAD reject, no throw)')
})

test('randomKEK is KEK_BYTES long and non-deterministic', (t) => {
  t.is(KEK_BYTES, 32)
  t.is(randomKEK().length, KEK_BYTES)
  t.unlike(randomKEK(), randomKEK(), 'two KEKs differ')
})

test('seal/open round-trips under the right key and header', (t) => {
  const secret = b4a.from('22'.repeat(32), 'hex')
  const key = randomKEK()
  const aad = b4a.from('mirall-identity|2|os-keychain')
  const box = seal(secret, key, aad)
  t.is(box.nonce.length, 24, 'an XChaCha20 nonce')
  t.alike(open(box, key, aad), secret)
  t.is(open(box, randomKEK(), aad), null, 'wrong key → null')
  t.is(open(box, key, b4a.from('mirall-identity|2|file')), null, 'a changed header → null')
  t.is(open({ ...box, nonce: box.nonce.subarray(0, 12) }, key, aad), null, 'a short nonce → null, not a throw')
  t.is(open({ ...box, ciphertext: b4a.alloc(4) }, key, aad), null, 'a truncated ciphertext → null')
})

test('a v1 secretbox envelope does not open as v2', (t) => {
  const key = randomKEK()
  const v1 = wrap(b4a.from('33'.repeat(32), 'hex'), key)
  t.is(open(v1, key, b4a.alloc(0)), null)
})

test('a truncated v1 envelope reads as unopenable, not a throw', (t) => {
  const key = randomKEK()
  const box = wrap(b4a.from('44'.repeat(32), 'hex'), key)
  t.is(unwrap({ ...box, nonce: box.nonce.subarray(0, 8) }, key), null)
  t.is(unwrap({ ...box, ciphertext: b4a.alloc(3) }, key), null)
})
