import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import crypto from 'crypto'
import sodium from 'sodium-native'
import { readRelaySeedHex, writeRelaySeedHex, clearRelaySeed, seedFile, _sealForTests } from '../../src/main/relay-secret.js'

const SEED = '9d73b3a76df0938ff055a76e4c096c54cc245b35d4db31b582faba9dde94ae4e'
const KEK = 'ab'.repeat(32)
const kekHex = () => crypto.randomBytes(32).toString('hex')

// Injected the way identity-kek.js already allows, so this runs under Node with no Electron.
const fakeSafeStorage = () => ({
  encryptString: (value) => Buffer.from('enc:' + value),
  decryptString: (buf) => Buffer.from(buf).toString().replace(/^enc:/, ''),
})
const noSafeStorage = { decryptString: () => { throw new Error('safeStorage must not be read') } }

function tmpStorage() {
  return path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'relay-secret-')), 'app-storage')
}

function writeSealed(storage, seedHex, kek) {
  fs.writeFileSync(seedFile(storage), _sealForTests(seedHex, kek), { mode: 0o600 })
}

test('the seed round-trips through the vault', (t) => {
  const storage = tmpStorage()
  const safeStorage = fakeSafeStorage()
  t.is(readRelaySeedHex(storage, KEK, { safeStorage }), null, 'absent until written')

  writeRelaySeedHex(storage, SEED, { safeStorage })
  t.is(readRelaySeedHex(storage, KEK, { safeStorage }), SEED)

  clearRelaySeed(storage)
  t.is(readRelaySeedHex(storage, KEK, { safeStorage }), null)
})

test('the vault sits beside the store and is owner-only', (t) => {
  const storage = tmpStorage()
  writeRelaySeedHex(storage, SEED, { safeStorage: fakeSafeStorage() })
  const file = seedFile(storage)
  t.is(path.dirname(file), path.dirname(storage), 'beside kek.enc, not inside the corestore')
  t.is(path.basename(file), 'relay-ticket.enc')
  t.is(fs.statSync(file).mode & 0o777, 0o600)
})

// Asserting the ciphertext would only test the fake. What matters is the boundary: the seed
// reaches disk through safeStorage and by no other route, so every installed build can read it.
test('the seed reaches disk only through safeStorage', (t) => {
  const storage = tmpStorage()
  const encrypted = []
  const safeStorage = {
    encryptString: (value) => { encrypted.push(value); return Buffer.from('sealed') },
    decryptString: () => SEED,
  }
  writeRelaySeedHex(storage, SEED, { safeStorage })
  t.alike(encrypted, [SEED], 'exactly one encryptString call, with the seed')
  t.is(fs.readFileSync(seedFile(storage), 'utf-8'), 'sealed', 'and only its output is written')
})

test('a non-hex seed is refused at write time', (t) => {
  const storage = tmpStorage()
  const safeStorage = fakeSafeStorage()
  t.exception(() => writeRelaySeedHex(storage, 'nope', { safeStorage }))
  t.exception(() => writeRelaySeedHex(storage, SEED.slice(0, 63), { safeStorage }))
  t.exception(() => writeRelaySeedHex(storage, SEED.toUpperCase(), { safeStorage }))
  t.is(readRelaySeedHex(storage, KEK, { safeStorage }), null, 'nothing was written')
})

test('a vault sealed under the identity key opens without safeStorage', (t) => {
  const storage = tmpStorage()
  writeSealed(storage, SEED, KEK)
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: noSafeStorage }), SEED)
})

test('reading a vault never rewrites it', (t) => {
  const storage = tmpStorage()
  writeRelaySeedHex(storage, SEED, { safeStorage: fakeSafeStorage() })
  const before = fs.readFileSync(seedFile(storage))
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: fakeSafeStorage() }), SEED)
  t.alike(fs.readFileSync(seedFile(storage)), before, 'an installed build sharing the store can still read it')
})

test('the sealed vault holds neither the seed nor the identity key', (t) => {
  const storage = tmpStorage()
  writeSealed(storage, SEED, KEK)
  const raw = fs.readFileSync(seedFile(storage))
  const env = JSON.parse(raw.toString('utf-8'))
  t.is(env.v, 2)
  t.is(Buffer.from(env.nonce, 'base64').length, 24, 'an XChaCha20 nonce')
  t.absent(raw.toString('utf-8').includes(SEED), 'no seed hex')
  t.is(raw.indexOf(Buffer.from(SEED, 'hex')), -1, 'no raw seed bytes')
})

// The KEK also wraps identity.enc under secretbox. A vault sealed with the bare KEK must not open:
// the sealing key is a subkey, so no key serves two primitives.
test('the vault is sealed under a subkey, not the identity key itself', (t) => {
  const storage = tmpStorage()
  const nonce = Buffer.alloc(24)
  sodium.randombytes_buf(nonce)
  const ciphertext = Buffer.alloc(32 + 16)
  sodium.crypto_aead_xchacha20poly1305_ietf_encrypt(ciphertext, Buffer.from(SEED, 'hex'), Buffer.from('mirall/relay-ticket/v2'), null, nonce, Buffer.from(KEK, 'hex'))
  fs.writeFileSync(seedFile(storage), JSON.stringify({ v: 2, nonce: nonce.toString('base64'), ciphertext: ciphertext.toString('base64') }))
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: noSafeStorage }), null)
})

test('a sealed vault does not open under another identity key, or with none', (t) => {
  const storage = tmpStorage()
  writeSealed(storage, SEED, KEK)
  t.is(readRelaySeedHex(storage, kekHex(), { safeStorage: noSafeStorage }), null)
  t.is(readRelaySeedHex(storage, null, { safeStorage: noSafeStorage }), null)
  t.is(readRelaySeedHex(storage, 'deadbeef', { safeStorage: noSafeStorage }), null)
})

test('a tampered or malformed sealed vault degrades to no seed', (t) => {
  const storage = tmpStorage()
  writeSealed(storage, SEED, KEK)
  const env = JSON.parse(fs.readFileSync(seedFile(storage), 'utf-8'))
  const ciphertext = Buffer.from(env.ciphertext, 'base64')
  ciphertext[0] ^= 1
  fs.writeFileSync(seedFile(storage), JSON.stringify({ ...env, ciphertext: ciphertext.toString('base64') }))
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: noSafeStorage }), null, 'a flipped bit')

  fs.writeFileSync(seedFile(storage), JSON.stringify({ ...env, nonce: 'AAAA' }))
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: noSafeStorage }), null, 'a short nonce')

  fs.writeFileSync(seedFile(storage), JSON.stringify({ v: 2 }))
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: noSafeStorage }), null, 'no fields')
})

test('a sealed vault of an unknown version is not handed to safeStorage', (t) => {
  const storage = tmpStorage()
  writeSealed(storage, SEED, KEK)
  const env = JSON.parse(fs.readFileSync(seedFile(storage), 'utf-8'))
  fs.writeFileSync(seedFile(storage), JSON.stringify({ ...env, v: 3 }))
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: noSafeStorage }), null)
})

// An unreadable vault means the private relay silently degrades to an ephemeral identity and
// the relay stops admitting us. Degrading is right — booting is better than not — but it must
// not throw into the worker spawn path.
test('a corrupt vault degrades to no seed rather than throwing', (t) => {
  const storage = tmpStorage()
  writeRelaySeedHex(storage, SEED, { safeStorage: fakeSafeStorage() })
  fs.writeFileSync(seedFile(storage), 'not encrypted at all')

  const throwing = { decryptString: () => { throw new Error('bad ciphertext') }, encryptString: (v) => Buffer.from(v) }
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: throwing }), null)

  const garbage = { decryptString: () => 'not a seed', encryptString: (v) => Buffer.from(v) }
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: garbage }), null, 'a decrypt that yields junk is not a seed')
})

test('clearing a vault that is not there is a no-op', (t) => {
  t.execution(() => clearRelaySeed(tmpStorage()))
})

test('a rewrite replaces the previous seed', (t) => {
  const storage = tmpStorage()
  const safeStorage = fakeSafeStorage()
  const other = 'f50ded0ad862192ce2c8e2e977a471fa773352ae07c3ce9fe2ea28b648a16210'
  writeRelaySeedHex(storage, SEED, { safeStorage })
  writeRelaySeedHex(storage, other, { safeStorage })
  t.is(readRelaySeedHex(storage, KEK, { safeStorage }), other)
  t.absent(fs.existsSync(seedFile(storage) + '.tmp'), 'the temp file does not linger')
})

// REGRESSION (FIX-5: clearRelaySeed swallowed every error, so a vault the OS refused to delete —
// a Windows lock, EPERM, a read-only volume — still returned success. The config then stopped
// naming a seed the node keeps presenting on every later boot, with nothing on screen to explain
// it and no path in the app that could find or remove it.)
test('REGRESSION (FIX-5: a vault that cannot be deleted is reported, not swallowed)', (t) => {
  const storage = tmpStorage()
  writeRelaySeedHex(storage, SEED, { safeStorage: fakeSafeStorage() })

  const dir = path.dirname(seedFile(storage))
  fs.chmodSync(dir, 0o500)
  t.teardown(() => { try { fs.chmodSync(dir, 0o700) } catch {} })

  t.exception(() => clearRelaySeed(storage), 'the caller has to learn the seed is still there')
  fs.chmodSync(dir, 0o700)
  t.is(readRelaySeedHex(storage, KEK, { safeStorage: fakeSafeStorage() }), SEED, 'and it really is')
})

test('clearing a vault that was never written still succeeds', (t) => {
  // `force: true` makes a missing file a no-op, so the throw above only ever reports a real
  // failure — removing a relay that has no seed must not look like an error.
  t.execution(() => clearRelaySeed(tmpStorage()))
})

test('a vault inside the store directory is read before the one beside it', (t) => {
  const storage = tmpStorage()
  fs.mkdirSync(storage)
  const safeStorage = fakeSafeStorage()
  const other = 'f50ded0ad862192ce2c8e2e977a471fa773352ae07c3ce9fe2ea28b648a16210'
  writeRelaySeedHex(storage, SEED, { safeStorage })
  fs.writeFileSync(path.join(storage, 'relay-ticket.enc'), _sealForTests(other, KEK))
  t.is(seedFile(storage), path.join(storage, 'relay-ticket.enc'))
  t.is(readRelaySeedHex(storage, KEK, { safeStorage }), other)
})
