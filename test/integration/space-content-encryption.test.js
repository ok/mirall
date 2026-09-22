import test from 'brittle'
import b4a from 'b4a'
import fs from 'bare-fs'
import path from 'bare-path'
import { openStore, getStore, setMasterSecret, createDrive } from '../../src/shared/core/store.js'
import { initSpaceKeys, putContentKey, getContentKeyForEpoch } from '../../src/shared/spaces/space-keys.js'
import { tmpDir } from '../helpers/bare-tmp.js'

test('v2 drive encrypts BOTH metadata and blobs under the SCK', async (t) => {
  const M = b4a.from('77'.repeat(32), 'hex')
  const root = tmpDir('sck-store')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  await openStore(storagePath)
  setMasterSecret(M)
  const sck = b4a.from('aa'.repeat(32), 'hex')
  const drive = createDrive('space-drive-enc', { encryptionKey: sck })
  await drive.ready()
  await drive.put('/secret/path.txt', b4a.from('classified'))
  const blobs = await drive.getBlobs()

  const metaRaw = await drive.core.get(drive.core.length - 1, { decrypt: false })
  t.absent(b4a.toString(metaRaw).includes('secret/path'), 'file path NOT in plaintext metadata block')
  const blobRaw = await blobs.core.get(0, { decrypt: false })
  t.absent(b4a.toString(blobRaw).includes('classified'), 'file content NOT in plaintext blob block')
  t.alike(await drive.get('/secret/path.txt'), b4a.from('classified'), 'decrypts with the SCK')

  await drive.close()
  await getStore().close()
})

test('space-keys.enc round-trips a joined SCK across restart', async (t) => {
  const M = b4a.from('33'.repeat(32), 'hex')
  const root = tmpDir('sck-vault')
  const storagePath = path.join(root, 'app-storage')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  await openStore(storagePath)
  setMasterSecret(M)
  await initSpaceKeys()
  const sck = b4a.from('cc'.repeat(32), 'hex')
  await putContentKey('space123', sck)
  await getStore().close()

  await openStore(storagePath)
  setMasterSecret(M)
  await initSpaceKeys()
  t.alike(getContentKeyForEpoch('space123', 0), sck, 'joined SCK survives restart, decrypts under the M-derived vault key')
  t.is(getContentKeyForEpoch('unknown', 0), null)
  await getStore().close()
})
