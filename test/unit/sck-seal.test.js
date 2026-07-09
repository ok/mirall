import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { sealSck, openSealedSck } from '../../src/shared/transfer/sck-seal.js'

test('sealSck/openSealedSck round-trips a 32-byte SCK to the bound signer', (t) => {
  const recipient = crypto.keyPair()
  const sck = crypto.randomBytes(32)
  const ct = sealSck(sck, recipient.publicKey)
  t.alike(openSealedSck(ct, recipient), sck, 'recipient recovers the SCK')
})

test('REGRESSION (MIR-25): a different recipient cannot open the sealed SCK', (t) => {
  const recipient = crypto.keyPair()
  const attacker = crypto.keyPair()
  const ct = sealSck(crypto.randomBytes(32), recipient.publicKey)
  t.is(openSealedSck(ct, attacker), null, 'wrong signer secret → null')
})

test('REGRESSION (MIR-25): a corrupted ciphertext does not open', (t) => {
  const recipient = crypto.keyPair()
  const ct = sealSck(crypto.randomBytes(32), recipient.publicKey)
  ct[0] ^= 0xff
  t.is(openSealedSck(ct, recipient), null, 'tampered ciphertext → null')
})

test('openSealedSck returns null (not throws) for a ciphertext shorter than the seal overhead', (t) => {
  const recipient = crypto.keyPair()
  t.is(openSealedSck(b4a.alloc(10), recipient), null, 'too-short ciphertext → null, no RangeError')
  t.is(openSealedSck(b4a.alloc(0), recipient), null, 'empty ciphertext → null')
})
