import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import { resolveMasterSecret, sealMasterSecret, storeHoldsIdentity } from '../../src/shared/core/identity.js'
import { osKeychainProvider } from '../../src/shared/core/unlock-provider.js'
import { randomKEK, wrap, seal } from '../../src/shared/core/identity-envelope.js'
import { deriveKeyPair, deriveParticipationKeyPair } from '../../src/shared/core/identity-keys.js'
import { tmpDir } from '../helpers/bare-tmp.js'

test('REGRESSION (MIR-02): migration preserves identity, scrubs the seed, re-unlocks across restart', async (t) => {
  const root = tmpDir('identity-mig-headline')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const store = new Corestore(storagePath)
  await store.ready()
  const oldProfile = (await store.createKeyPair('profile')).publicKey
  const oldParticipation = (await store.namespace('space-drive-x').createKeyPair('db')).publicKey
  // A realistic legacy (pre-envelope) install has actual cores derived from the seed,
  // not just derived keypairs — that is what marks it as migrating rather than fresh.
  await store.get({ name: 'profile' }).append(b4a.from('x'))
  const kekHex = b4a.toString(randomKEK(), 'hex')

  const M = await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) })
  t.alike(deriveKeyPair(M, 'profile').publicKey, oldProfile, 'profile identity preserved')
  t.alike(deriveParticipationKeyPair(M, 'x').publicKey, oldParticipation, 'participation identity preserved')
  t.ok(fs.existsSync(path.join(root, 'identity.enc')), 'envelope written')
  await store.close()

  // Reopen from disk: the scrubbed seed can no longer derive the old identity,
  // but the envelope still unlocks the same M.
  const store2 = new Corestore(storagePath)
  await store2.ready()
  t.unlike((await store2.createKeyPair('profile')).publicKey, oldProfile, 'scrubbed seed derives a different key')
  t.alike(await resolveMasterSecret({ store: store2, storagePath, provider: osKeychainProvider(kekHex) }), M, 'restart re-unlocks the same M')
  await store2.close()
})

test('wrong KEK fails closed', async (t) => {
  const root = tmpDir('identity-mig-wrongkek')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const store = new Corestore(storagePath)
  await store.ready()
  await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(b4a.toString(randomKEK(), 'hex')) })
  await store.close()

  const store2 = new Corestore(storagePath)
  await store2.ready()
  try {
    await resolveMasterSecret({ store: store2, storagePath, provider: osKeychainProvider(b4a.toString(randomKEK(), 'hex')) })
    t.fail('a different KEK unlocked the envelope')
  } catch (err) {
    t.is(err.code, 'IDENTITY_UNLOCK_FAILED')
    t.is(err.message, 'identity unlock failed')
  }
  await store2.close()
})

test('interrupted migration: envelope present but seed not yet scrubbed → re-unlocks the same M', async (t) => {
  const root = tmpDir('identity-mig-interrupted')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const store = new Corestore(storagePath)
  await store.ready()
  const M0 = b4a.from(store.primaryKey)
  const oldProfile = (await store.createKeyPair('profile')).publicKey
  const kekHex = b4a.toString(randomKEK(), 'hex')
  // Simulate a crash right after the envelope fsync, before the seed scrub: write
  // identity.enc by hand and leave the persisted seed intact.
  const { nonce, ciphertext } = wrap(M0, b4a.from(kekHex, 'hex'))
  fs.writeFileSync(path.join(root, 'identity.enc'), JSON.stringify({
    v: 1, provider: 'os-keychain', nonce: b4a.toString(nonce, 'base64'), ciphertext: b4a.toString(ciphertext, 'base64'),
  }))
  await store.close()

  const store2 = new Corestore(storagePath)
  await store2.ready()
  const M = await resolveMasterSecret({ store: store2, storagePath, provider: osKeychainProvider(kekHex) })
  t.alike(M, M0, 'unwraps the same M from the envelope')
  t.alike(deriveKeyPair(M, 'profile').publicKey, oldProfile, 'identity preserved despite the un-scrubbed seed')
  await store2.close()
})

test('resolves from an un-readied store (a freshly constructed Corestore, as the envelope path allows)', async (t) => {
  const root = tmpDir('identity-mig-unready')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const kekHex = b4a.toString(randomKEK(), 'hex')
  // Exactly what the worker passes: a freshly constructed, NOT-yet-readied store.
  const store = new Corestore(storagePath)
  const M = await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) })
  t.is(M.length, 32, 'resolves M without a prior store.ready()')
  t.ok(fs.existsSync(path.join(root, 'identity.enc')), 'envelope written')
  await store.close()
})

async function sealedStore(t, label) {
  const root = tmpDir(label)
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const kekHex = b4a.toString(randomKEK(), 'hex')
  const store = new Corestore(storagePath)
  const M = await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) })
  await store.close()
  const reopened = new Corestore(storagePath)
  t.teardown(() => reopened.close())
  return { root, storagePath, kekHex, M, store: reopened }
}

test('an envelope sealed by one provider refuses another, even with the same KEK', async (t) => {
  const { storagePath, kekHex, store } = await sealedStore(t, 'identity-provider-mismatch')
  const kek = b4a.from(kekHex, 'hex')
  let asked = 0
  const other = { name: 'file', getKEK: async () => { asked++; return kek } }
  try {
    await resolveMasterSecret({ store, storagePath, provider: other })
    t.fail('a different provider unlocked the envelope')
  } catch (err) {
    t.is(err.code, 'IDENTITY_PROVIDER_MISMATCH')
    t.ok(err.message.includes('"os-keychain"') && err.message.includes('"file"'), 'the message names both providers')
  }
  t.is(asked, 0, 'a provider that cannot open the envelope is never asked for a key')
})

test('a provider with no KEK to give fails with IDENTITY_NO_KEK', async (t) => {
  const { storagePath, store } = await sealedStore(t, 'identity-provider-empty')
  try {
    await resolveMasterSecret({ store, storagePath, provider: { name: 'os-keychain', getKEK: async () => null } })
    t.fail('resolved without a KEK')
  } catch (err) {
    t.is(err.code, 'IDENTITY_NO_KEK')
  }
})

function writeV2(file, M, kekHex, { provider = 'os-keychain', aadProvider = provider, v = 2, aadV = v } = {}) {
  const { nonce, ciphertext } = seal(M, b4a.from(kekHex, 'hex'), b4a.from(`mirall-identity|${aadV}|${aadProvider}`))
  fs.writeFileSync(file, JSON.stringify({ v, provider, nonce: b4a.toString(nonce, 'base64'), ciphertext: b4a.toString(ciphertext, 'base64') }))
}

async function unlockCode(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

test('REGRESSION (MIR-36: the envelope header was unauthenticated) — a v2 envelope unlocks', async (t) => {
  const { root, storagePath, kekHex, M, store } = await sealedStore(t, 'identity-v2')
  writeV2(path.join(root, 'identity.enc'), M, kekHex)
  t.alike(await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) }), M)
})

test('a v2 envelope whose header was changed does not unlock', async (t) => {
  const { root, storagePath, kekHex, M, store } = await sealedStore(t, 'identity-v2-tamper')
  const file = path.join(root, 'identity.enc')
  const provider = osKeychainProvider(kekHex)

  writeV2(file, M, kekHex, { aadProvider: 'file' })
  t.is(await unlockCode(resolveMasterSecret({ store, storagePath, provider })), 'IDENTITY_UNLOCK_FAILED', 'a provider name the tag does not cover')

  writeV2(file, M, kekHex, { aadV: 3 })
  t.is(await unlockCode(resolveMasterSecret({ store, storagePath, provider })), 'IDENTITY_UNLOCK_FAILED', 'a version the tag does not cover')
})

test('an envelope version this build does not know is refused', async (t) => {
  const { root, storagePath, kekHex, M, store } = await sealedStore(t, 'identity-v9')
  writeV2(path.join(root, 'identity.enc'), M, kekHex, { v: 9 })
  t.is(await unlockCode(resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) })), 'IDENTITY_UNLOCK_FAILED')
})

test('identity.enc inside the store directory is read before the one beside it', async (t) => {
  const { root, storagePath, kekHex, store } = await sealedStore(t, 'identity-inside')
  const inside = b4a.from('77'.repeat(32), 'hex')
  writeV2(path.join(storagePath, 'identity.enc'), inside, kekHex)
  t.alike(await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) }), inside)
  t.ok(fs.existsSync(path.join(root, 'identity.enc')), 'the one beside it is left alone')
})

test('sealMasterSecret replaces the envelope where it is read from', async (t) => {
  const { root, storagePath, kekHex, store } = await sealedStore(t, 'identity-reseal')
  const provider = osKeychainProvider(kekHex)
  const recovered = b4a.from('88'.repeat(32), 'hex')
  await sealMasterSecret({ storagePath, provider, masterSecret: recovered })
  t.alike(await resolveMasterSecret({ store, storagePath, provider }), recovered, 'the next unlock returns the adopted secret')
  t.is(JSON.parse(b4a.toString(fs.readFileSync(path.join(root, 'identity.enc')))).v, 1, 'written in the format every build reads')
  t.absent(fs.existsSync(path.join(root, 'identity.enc.tmp')), 'atomically')
  t.absent(fs.existsSync(path.join(storagePath, 'identity.enc')), 'and beside the store')
})

test('storeHoldsIdentity tells a store written under M from one written under another key', async (t) => {
  const root = tmpDir('identity-holds')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  const store = new Corestore(storagePath)
  t.teardown(() => store.close())
  const M1 = b4a.from('91'.repeat(32), 'hex')
  const M2 = b4a.from('92'.repeat(32), 'hex')

  t.alike(await storeHoldsIdentity(store, M1), { hasCores: false, holdsProfile: false }, 'a fresh store holds nothing')

  const profile = store.get({ keyPair: deriveKeyPair(M1, 'profile') })
  await profile.append(b4a.from('x'))
  t.alike(await storeHoldsIdentity(store, M1), { hasCores: true, holdsProfile: true })
  t.alike(await storeHoldsIdentity(store, M2), { hasCores: true, holdsProfile: false })
})

test('an envelope that cannot even be parsed locks the identity instead of crashing', async (t) => {
  const { root, storagePath, kekHex, store } = await sealedStore(t, 'identity-malformed')
  const file = path.join(root, 'identity.enc')
  const provider = osKeychainProvider(kekHex)
  for (const [label, text] of [['empty', ''], ['null', 'null'], ['not JSON', '{'], ['no fields', '{"v":1,"provider":"os-keychain"}'],
    ['a truncated ciphertext', JSON.stringify({ v: 1, provider: 'os-keychain', nonce: 'AAAA', ciphertext: 'AA==' })]]) {
    fs.writeFileSync(file, text)
    t.is(await unlockCode(resolveMasterSecret({ store, storagePath, provider })), 'IDENTITY_UNLOCK_FAILED', label)
  }
})
