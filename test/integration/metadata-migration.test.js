import test from 'brittle'
import b4a from 'b4a'
import os from 'bare-os'
import fs from 'bare-fs'
import path from 'bare-path'
import { initStore, getStore, setMasterSecret, createBee, createLocalBee, LOCAL_BEE_NAMES } from '../../src/shared/core/store.js'
import { migrateLocalBeesToEncrypted } from '../../src/shared/storage/metadata-migration.js'

function tmp (label) {
  const dir = path.join(os.tmpdir(), `mir40-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function listDks (store) {
  const out = new Set()
  for await (const dk of store.list()) out.add(b4a.toString(dk, 'hex'))
  return out
}

async function rawContains (core, needle) {
  for (let i = 0; i < core.length; i++) {
    const blk = await core.get(i, { decrypt: false })
    if (blk && b4a.toString(blk).includes(needle)) return true
  }
  return false
}

test('REGRESSION (MIR-40): legacy plaintext bee migrates to encrypted, entries preserved + legacy purged', async (t) => {
  const M = b4a.from('55'.repeat(32), 'hex')
  const root = tmp('migrate')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  initStore(path.join(root, 'app-storage'))
  setMasterSecret(M)

  const legacy = createBee('spaces-meta')
  await legacy.put('space/a', { name: 'Alpha' })
  await legacy.put('space/b', { name: 'Bravo' })
  await legacy.core.ready()
  const legacyDk = b4a.toString(legacy.core.discoveryKey, 'hex')
  await legacy.close()

  t.ok(await migrateLocalBeesToEncrypted(), 'migration ran')

  const enc = createLocalBee('spaces-meta')
  t.is((await enc.get('space/a')).value.name, 'Alpha', 'entry a preserved')
  t.is((await enc.get('space/b')).value.name, 'Bravo', 'entry b preserved')
  t.absent(await rawContains(enc.core, 'Alpha'), 'v2 metadata is ciphertext')
  t.absent(await rawContains(enc.core, 'Bravo'), 'v2 metadata is ciphertext')

  const marker = path.join(root, 'app-storage', '.mir40-bees-v1')
  t.ok(fs.existsSync(marker), 'marker written')
  t.absent((await listDks(getStore())).has(legacyDk), 'legacy plaintext core purged')

  await getStore().close()
})

test('REGRESSION (MIR-40): migration is idempotent', async (t) => {
  const M = b4a.from('66'.repeat(32), 'hex')
  const root = tmp('idem')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  initStore(path.join(root, 'app-storage'))
  setMasterSecret(M)
  const legacy = createBee('downloads-meta')
  await legacy.put('x:y', { downloadedAt: 1 })
  await legacy.close()

  t.ok(await migrateLocalBeesToEncrypted(), 'first run migrates')
  const after = await createLocalBee('downloads-meta')
  await after.ready()
  const lenAfterFirst = after.core.length

  t.absent(await migrateLocalBeesToEncrypted(), 'second run is a no-op (marker present)')
  const enc = createLocalBee('downloads-meta')
  await enc.ready()
  t.is(enc.core.length, lenAfterFirst, 'no extra appends on the second run')
  t.is((await enc.get('x:y')).value.downloadedAt, 1, 'entry intact')

  await getStore().close()
})

test('REGRESSION (MIR-40): fresh install writes the marker and migrates nothing', async (t) => {
  const M = b4a.from('77'.repeat(32), 'hex')
  const root = tmp('fresh')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  initStore(path.join(root, 'app-storage'))
  setMasterSecret(M)

  t.absent(await migrateLocalBeesToEncrypted(), 'nothing migrated on a fresh store')
  t.ok(fs.existsSync(path.join(root, 'app-storage', '.mir40-bees-v1')), 'marker written')
  t.is((await listDks(getStore())).size, 0, 'migration created no cores on a fresh store (probe guard)')

  const bee = createLocalBee('spaces-meta')
  await bee.put('space/a', { name: 'Alpha' })
  t.is((await bee.get('space/a')).value.name, 'Alpha', 'encrypted bee usable after a fresh-install migration')

  await getStore().close()
})

test('REGRESSION (MIR-40): no M → migration is a no-op, leaves no marker', async (t) => {
  const root = tmp('nokey')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  initStore(path.join(root, 'app-storage'))
  setMasterSecret(null)

  t.absent(await migrateLocalBeesToEncrypted(), 'no-op without a master secret')
  t.absent(fs.existsSync(path.join(root, 'app-storage', '.mir40-bees-v1')), 'no marker in insecure mode')

  await getStore().close()
})

test('REGRESSION (MIR-40): an existing install leaves no plaintext metadata core', async (t) => {
  const M = b4a.from('88'.repeat(32), 'hex')
  const root = tmp('nolinger')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  initStore(path.join(root, 'app-storage'))
  setMasterSecret(M)

  const legacy = createBee('spaces-meta')
  await legacy.put('space/a', { name: 'Alpha' })
  await legacy.core.ready()
  const legacyDk = b4a.toString(legacy.core.discoveryKey, 'hex')
  await legacy.close()

  t.ok(await migrateLocalBeesToEncrypted(), 'migration ran')

  const dks = await listDks(getStore())
  t.absent(dks.has(legacyDk), 'seeded legacy plaintext core purged')
  t.is(dks.size, LOCAL_BEE_NAMES.length, 'only the v2 cores remain — phantom legacy cores for unpopulated bees were purged')

  await getStore().close()
})

test('REGRESSION (MIR-40): re-run after the marker is removed is clean and idempotent', async (t) => {
  const M = b4a.from('99'.repeat(32), 'hex')
  const root = tmp('rerun')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const sp = path.join(root, 'app-storage')
  initStore(sp)
  setMasterSecret(M)
  const legacy = createBee('mounts-meta')
  await legacy.put('owned-folder-mount/a', { path: '/x' })
  await legacy.close()

  t.ok(await migrateLocalBeesToEncrypted(), 'first run migrates')
  const dksAfterFirst = await listDks(getStore())
  fs.rmSync(path.join(sp, '.mir40-bees-v1'))
  await getStore().close()

  // reboot (fresh corestore) before the re-run, as production would
  initStore(sp)
  setMasterSecret(M)
  t.absent(await migrateLocalBeesToEncrypted(), 'second boot migrates nothing (legacy already purged)')

  const enc = createLocalBee('mounts-meta')
  t.is((await enc.get('owned-folder-mount/a')).value.path, '/x', 'entry intact after re-run')
  t.alike(await listDks(getStore()), dksAfterFirst, 're-run added no cores')
  t.ok(fs.existsSync(path.join(sp, '.mir40-bees-v1')), 'marker re-written')

  await getStore().close()
})

test('REGRESSION (MIR-40): a marker-write failure does not crash boot and is retried', async (t) => {
  const M = b4a.from('ab'.repeat(32), 'hex')
  const root = tmp('markerfail')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const sp = path.join(root, 'app-storage')
  initStore(sp)
  setMasterSecret(M)
  const legacy = createBee('spaces-meta')
  await legacy.put('space/a', { name: 'Alpha' })
  await legacy.close()

  // Block the atomic write: a directory where the temp file would be created makes
  // openSync('w') throw — the migration must swallow it and leave the marker absent.
  const marker = path.join(sp, '.mir40-bees-v1')
  fs.mkdirSync(marker + '.tmp', { recursive: true })

  t.absent(await migrateLocalBeesToEncrypted(), 'returns false on marker-write failure (no throw)')
  t.absent(fs.existsSync(marker), 'marker not written when the write fails')
  t.is((await createLocalBee('spaces-meta').get('space/a')).value.name, 'Alpha', 'data already migrated despite marker failure')

  // Unblock and reboot (fresh process = fresh corestore) — the next boot retries.
  fs.rmSync(marker + '.tmp', { recursive: true, force: true })
  await getStore().close()
  initStore(sp)
  setMasterSecret(M)

  t.absent(await migrateLocalBeesToEncrypted(), 'retry migrates nothing new (legacy already purged)')
  t.ok(fs.existsSync(marker), 'marker written on retry')
  t.is((await createLocalBee('spaces-meta').get('space/a')).value.name, 'Alpha', 'data intact after retry')

  await getStore().close()
})
