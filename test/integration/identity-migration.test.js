import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import { resolveMasterSecret } from '../../src/shared/core/identity-resolve.js'
import { osKeychainProvider } from '../../src/shared/core/unlock-providers.js'
import { randomKEK, wrap } from '../../src/shared/core/identity-envelope.js'
import { deriveKeyPair, deriveDriveKeyPair } from '../../src/shared/core/identity-keys.js'

function tmp(label) {
  const dir = path.join(os.tmpdir(), `identity-mig-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('REGRESSION (MIR-02): migration preserves identity, scrubs the seed, re-unlocks across restart', async (t) => {
  const root = tmp('headline')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const store = new Corestore(storagePath)
  await store.ready()
  const oldProfile = (await store.createKeyPair('profile')).publicKey
  const oldDrive = (await store.namespace('space-drive-x').createKeyPair('db')).publicKey
  // A realistic legacy (pre-envelope) install has actual cores derived from the seed,
  // not just derived keypairs — that is what marks it as migrating rather than fresh.
  await store.get({ name: 'profile' }).append(b4a.from('x'))
  const kekHex = b4a.toString(randomKEK(), 'hex')

  const M = await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(kekHex) })
  t.alike(deriveKeyPair(M, 'profile').publicKey, oldProfile, 'profile identity preserved')
  t.alike(deriveDriveKeyPair(M, 'space-drive-x').publicKey, oldDrive, 'drive identity preserved')
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
  const root = tmp('wrongkek')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const store = new Corestore(storagePath)
  await store.ready()
  await resolveMasterSecret({ store, storagePath, provider: osKeychainProvider(b4a.toString(randomKEK(), 'hex')) })
  await store.close()

  const store2 = new Corestore(storagePath)
  await store2.ready()
  await t.exception(
    resolveMasterSecret({ store: store2, storagePath, provider: osKeychainProvider(b4a.toString(randomKEK(), 'hex')) }),
    /identity unlock failed/,
    'a different KEK cannot unlock the envelope'
  )
  await store2.close()
})

test('interrupted migration: envelope present but seed not yet scrubbed → re-unlocks the same M', async (t) => {
  const root = tmp('interrupted')
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

test('resolves from an un-readied store (mirrors the worker wiring: initStore → resolveMasterSecret)', async (t) => {
  const root = tmp('unready')
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
