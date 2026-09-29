import test from 'brittle'
import b4a from 'b4a'
import sodium from 'sodium-native'
import {
  buildRecoveryFile, openRecoveryFile, assertPassphrase, identityPublicKeyHex,
  MAX_RECOVERY_FILE_BYTES,
} from '../../src/shared/core/identity-recovery.js'
import { deriveKeyPair } from '../../src/shared/core/identity-keys.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { readRecoveryHeader } from '../../src/shared/contract/recovery-key.js'

const M = b4a.from('4d'.repeat(32), 'hex')
const PASS = 'correct horse battery'
const CREATED_AT = '2026-09-29T08:00:00.000Z'
// The cheapest parameters libsodium accepts: the format and the AAD are the subject, not the cost.
const FAST = { opslimit: sodium.crypto_pwhash_OPSLIMIT_MIN, memlimit: sodium.crypto_pwhash_MEMLIMIT_MIN }

const build = (opts = {}) => buildRecoveryFile({ master: M }, PASS, { createdAt: CREATED_AT, kdf: FAST, ...opts })

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

test('REGRESSION (MIR-30: nothing the user could save restored their identity)', async (t) => {
  const text = await build()
  const opened = await openRecoveryFile(text, PASS)
  t.alike(opened.masterSecret, M, 'the same master secret comes back')
  t.is(opened.identityPub, identityPublicKeyHex(M))
  t.is(opened.createdAt, CREATED_AT)
})

test('the identity public key is the profile key the network knows', (t) => {
  t.is(identityPublicKeyHex(M), b4a.toString(deriveKeyPair(M, 'profile').publicKey, 'hex'))
})

test('the file carries a master slot and never the secret in the clear', async (t) => {
  const text = await build()
  const file = JSON.parse(text)
  t.is(file.type, 'mirall-recovery-key')
  t.is(file.v, 1)
  t.alike(file.slots, ['master'])
  t.is(file.kdf.alg, 'argon2id')
  t.absent(text.includes(b4a.toString(M, 'hex')), 'no hex M')
  t.absent(text.includes(b4a.toString(M, 'base64')), 'no base64 M')
})

test('a wrong passphrase is WRONG_PASSPHRASE', async (t) => {
  t.is(await codeOf(openRecoveryFile(await build(), 'not the passphrase')), CODES.WRONG_PASSPHRASE)
})

test('every header field the reader trusts is bound into the tag', async (t) => {
  const file = JSON.parse(await build())
  const other = identityPublicKeyHex(b4a.from('11'.repeat(32), 'hex'))
  const tampered = {
    identityPub: { ...file, identityPub: other },
    slots: { ...file, slots: ['master', 'person'] },
    salt: { ...file, kdf: { ...file.kdf, salt: b4a.toString(b4a.alloc(16, 7), 'base64') } },
    opslimit: { ...file, kdf: { ...file.kdf, opslimit: FAST.opslimit + 1 } },
    memlimit: { ...file, kdf: { ...file.kdf, memlimit: FAST.memlimit * 2 } },
    createdAt: { ...file, createdAt: '2020-01-01T00:00:00.000Z' },
  }
  for (const [field, changed] of Object.entries(tampered)) {
    t.is(await codeOf(openRecoveryFile(JSON.stringify(changed), PASS)), CODES.WRONG_PASSPHRASE, field)
  }
  const ciphertext = b4a.from(file.ciphertext, 'base64')
  ciphertext[0] ^= 1
  t.is(await codeOf(openRecoveryFile(JSON.stringify({ ...file, ciphertext: b4a.toString(ciphertext, 'base64') }), PASS)),
    CODES.WRONG_PASSPHRASE, 'ciphertext')
})

test('a file that is not a recovery key is RECOVERY_FILE_INVALID', async (t) => {
  const file = JSON.parse(await build())
  const invalid = {
    'not json': 'hello',
    'json array': '[]',
    'another type': JSON.stringify({ ...file, type: 'something-else' }),
    'a newer version': JSON.stringify({ ...file, v: 2 }),
    'no master slot': JSON.stringify({ ...file, slots: ['person'] }),
    'another kdf': JSON.stringify({ ...file, kdf: { ...file.kdf, alg: 'scrypt' } }),
    'a cost above the bound': JSON.stringify({ ...file, kdf: { ...file.kdf, memlimit: sodium.crypto_pwhash_MEMLIMIT_SENSITIVE } }),
    'a cost below the bound': JSON.stringify({ ...file, kdf: { ...file.kdf, opslimit: 0 } }),
    'a short salt': JSON.stringify({ ...file, kdf: { ...file.kdf, salt: 'AAAA' } }),
    'a short nonce': JSON.stringify({ ...file, nonce: 'AAAA' }),
    'too large': JSON.stringify({ ...file, pad: 'x'.repeat(MAX_RECOVERY_FILE_BYTES) }),
  }
  for (const [label, text] of Object.entries(invalid)) {
    t.is(await codeOf(openRecoveryFile(text, PASS)), CODES.RECOVERY_FILE_INVALID, label)
  }
})

test('a plaintext without a usable master slot is refused; an extra slot is ignored', async (t) => {
  const withExtra = await buildRecoveryFile({ master: M, person: b4a.alloc(32, 9) }, PASS, { createdAt: CREATED_AT, kdf: FAST })
  t.alike(JSON.parse(withExtra).slots, ['master', 'person'])
  t.alike((await openRecoveryFile(withExtra, PASS)).masterSecret, M, 'a slot this build does not read is not fatal')
  await t.exception(buildRecoveryFile({ person: b4a.alloc(32, 9) }, PASS, { createdAt: CREATED_AT, kdf: FAST }), 'a bundle needs a master slot')
})

test('the header reads without the passphrase', async (t) => {
  const header = readRecoveryHeader(await build())
  t.is(header.identityPub, identityPublicKeyHex(M))
  t.is(header.createdAt, CREATED_AT)
  t.is(readRecoveryHeader('nope'), null)
  t.is(readRecoveryHeader(JSON.stringify({ type: 'mirall-recovery-key', v: 2, identityPub: 'x', createdAt: 'y' })), null, 'a newer version')
})

test('a passphrase is at least the minimum, counted in characters', (t) => {
  t.exception(() => assertPassphrase('123456789'))
  t.execution(() => assertPassphrase('1234567890'))
  t.exception(() => assertPassphrase('🔑'.repeat(9)), 'nine emoji are nine characters, not eighteen code units')
  t.execution(() => assertPassphrase('🔑'.repeat(10)))
})

test('the default cost is the one the file records', async (t) => {
  const file = JSON.parse(await buildRecoveryFile({ master: M }, PASS, { createdAt: CREATED_AT }))
  t.is(file.kdf.opslimit, sodium.crypto_pwhash_OPSLIMIT_SENSITIVE)
  t.is(file.kdf.memlimit, sodium.crypto_pwhash_MEMLIMIT_MODERATE)
  t.alike((await openRecoveryFile(JSON.stringify(file), PASS)).masterSecret, M)
})
