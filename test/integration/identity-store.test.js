import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import Corestore from 'corestore'
import Hyperdrive from 'hyperdrive'
import { openStore, getStore, setMasterSecret, createBee, ownParticipationId } from '../../src/shared/core/store.js'
import { tmpDir } from '../helpers/bare-tmp.js'

// Guards the explicit-keypair store path: createBee must open a writable core from a derived
// keyPair, round-trip data, reopen the same key after a restart, and stay byte-identical to today's
// seed-derived core (so migration preserves identity). The participation id must equal the key a
// Hyperdrive of the same name has under the same seed — that key is what every peer already holds
// for this member, so a drift here changes every member's identity in every space.
test('explicit-keypair createBee and the participation id: restart-stable, identity-preserving', async (t) => {
  const M = b4a.from('55'.repeat(32), 'hex')
  const root = tmpDir('identity-store-store')
  const storagePath = path.join(root, 'app-storage')

  const vanillaDir = tmpDir('identity-store-vanilla')
  const vanilla = new Corestore(vanillaDir, { primaryKey: M, unsafe: true })
  await vanilla.ready()
  const vBee = vanilla.get({ name: 'profile' })
  await vBee.ready()
  const expectedProfileKey = vBee.key
  const drives = [new Hyperdrive(vanilla.namespace('space-drive-x')), new Hyperdrive(vanilla.namespace('space-drive-x-ab12'))]
  for (const d of drives) await d.ready()
  const [plainDriveKey, suffixedDriveKey] = drives.map((d) => b4a.toString(d.core.key, 'hex'))

  t.teardown(async () => {
    for (const d of drives) { try { await d.close() } catch {} }
    try { await vanilla.close() } catch {}
    try { fs.rmSync(vanillaDir, { recursive: true, force: true }) } catch {}
    try { fs.rmSync(root, { recursive: true, force: true }) } catch {}
  })

  await openStore(storagePath)
  setMasterSecret(M)

  const bee = createBee('profile')
  await bee.ready()
  t.ok(bee.core.writable, 'profile bee writable')
  t.alike(bee.core.key, expectedProfileKey, 'profile core key == seed-derived')
  await bee.put('displayName', 'Alice')
  t.is(ownParticipationId('x', undefined), plainDriveKey, 'unsuffixed participation id == that drive key')
  t.is(ownParticipationId('x', 'ab12'), suffixedDriveKey, 'suffixed participation id == that drive key')
  await bee.close()
  await getStore().close()

  await openStore(storagePath)
  setMasterSecret(M)
  const bee2 = createBee('profile')
  await bee2.ready()
  t.is((await bee2.get('displayName')).value, 'Alice', 'bee data survives restart')
  t.is(ownParticipationId('x', 'ab12'), suffixedDriveKey, 'participation id stable across restart')
  await bee2.close()
  await getStore().close()
})
