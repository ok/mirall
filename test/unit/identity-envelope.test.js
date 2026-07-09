import test from 'brittle'
import b4a from 'b4a'
import { wrap, unwrap, randomKEK, zero, KEK_BYTES } from '../../src/shared/core/identity-envelope.js'

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

test('zero wipes a buffer in place', (t) => {
  const buf = b4a.from('ab'.repeat(16), 'hex')
  zero(buf)
  t.alike(buf, b4a.alloc(buf.length), 'buffer zeroed')
})
