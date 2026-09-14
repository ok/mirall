import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import Corestore from 'corestore'
import { deriveKeyPair, deriveDriveKeyPair } from '../../src/shared/core/identity-keys.js'
import { tmpDir } from '../helpers/bare-tmp.js'

// Pins identity-keys.js against Corestore's own seed-derivation: the derived
// public keys must equal what `new Corestore({ primaryKey: M })` produces, or the
// carry-forward migration would change the user's identity. Re-run after any
// corestore bump.
test('derived keys match Corestore seed-derivation byte-for-byte', async (t) => {
  const M = b4a.from('44'.repeat(32), 'hex')
  const dir = tmpDir('identity-pin-cs')
  const store = new Corestore(dir, { primaryKey: M, unsafe: true })
  await store.ready()
  t.teardown(async () => {
    try { await store.close() } catch {}
    try { fs.rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  t.alike(deriveKeyPair(M, 'profile').publicKey, (await store.createKeyPair('profile')).publicKey, 'profile key matches')
  t.alike(deriveKeyPair(M, 'spaces-meta').publicKey, (await store.createKeyPair('spaces-meta')).publicKey, 'named bee key matches')
  t.alike(
    deriveDriveKeyPair(M, 'space-drive-x').publicKey,
    (await store.namespace('space-drive-x').createKeyPair('db')).publicKey,
    'drive db key matches'
  )
})
