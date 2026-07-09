import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { initStore, getStore, setMasterSecret, createBee, createDrive } from '../../src/shared/core/store.js'

// Guards the explicit-keypair store path, including the private Hyperdrive `_db`
// option: createBee/createDrive must open writable cores from a derived keyPair,
// round-trip data (meta + blobs), reopen the same keys after a restart, and stay
// byte-identical to today's seed-derived cores (so migration preserves identity).
function tmp(label) {
  const dir = path.join(os.tmpdir(), `identity-store-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

test('explicit-keypair createBee/createDrive: writable, round-trips, restart-stable, identity-preserving', async (t) => {
  const M = b4a.from('55'.repeat(32), 'hex')
  const root = tmp('store')
  const storagePath = path.join(root, 'app-storage')

  // What today's seed-derivation (primaryKey = M) produces, for the identity check.
  const vanillaDir = tmp('vanilla')
  const vanilla = new Corestore(vanillaDir, { primaryKey: M, unsafe: true })
  await vanilla.ready()
  const vBee = vanilla.get({ name: 'profile' })
  await vBee.ready()
  const expectedProfileKey = vBee.key
  const vDrive = new Hyperdrive(vanilla.namespace('space-drive-x'))
  await vDrive.ready()
  const expectedDriveKey = vDrive.core.key

  t.teardown(async () => {
    try { await vDrive.close() } catch {}
    try { await vanilla.close() } catch {}
    try { fs.rmSync(vanillaDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })

  initStore(storagePath)
  setMasterSecret(M)

  const bee = createBee('profile')
  await bee.ready()
  t.ok(bee.core.writable, 'profile bee writable')
  t.alike(bee.core.key, expectedProfileKey, 'profile core key == seed-derived')
  await bee.put('displayName', 'Alice')

  const drive = createDrive('space-drive-x')
  await drive.ready()
  t.ok(drive.core.writable, 'drive meta core writable')
  t.alike(drive.core.key, expectedDriveKey, 'drive meta core key == seed-derived')
  await drive.put('/a.txt', b4a.from('hello'))
  t.alike(await drive.get('/a.txt'), b4a.from('hello'), 'drive blob round-trips')
  const blobs = await drive.getBlobs()
  t.ok(blobs && blobs.core, 'blobs core present')
  const driveKeyHex = b4a.toString(drive.core.key, 'hex')

  await drive.close()
  await bee.close()
  await getStore().close()

  // Restart: same M reopens the same cores + data.
  initStore(storagePath)
  setMasterSecret(M)
  const bee2 = createBee('profile')
  await bee2.ready()
  t.is((await bee2.get('displayName')).value, 'Alice', 'bee data survives restart')
  const drive2 = createDrive('space-drive-x')
  await drive2.ready()
  t.is(b4a.toString(drive2.core.key, 'hex'), driveKeyHex, 'drive key stable across restart')
  t.alike(await drive2.get('/a.txt'), b4a.from('hello'), 'drive data survives restart')
  await drive2.close()
  await bee2.close()
  await getStore().close()
})
