import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { boot } from '../../src/worker/boot.js'
import { getStore, sealRecoveryKey, backupWrapKey } from '../../src/shared/core/store.js'
import { setProfile, getProfile, getProfileBee } from '../../src/shared/spaces/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { listSpaces } from '../../src/shared/spaces/space.js'
import { advertise, ownCatalog, catalogNameForSpace } from '../../src/shared/shares/own-catalog.js'
import { isHeld, writeRestoreHold, PROFILE_BEE } from '../../src/shared/core/restore-hold.js'
import { applyPendingIdentityChange, stagingPath } from '../../src/shared/core/identity-adopt.js'
import { registerBackupRestore } from '../../src/worker/ipc/backup-restore.js'
import { registerProfile } from '../../src/worker/ipc/profile.js'
import { FolderTarget, REPO_DIR } from '../../src/shared/storage/backup/folder-target.js'
import { runBackup } from '../../src/shared/storage/backup/backup-run.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { createPassphraseThrottle } from '../../src/shared/core/identity-recovery.js'
import { waitFor } from '../helpers/bare-poll.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const PASS = 'a long enough passphrase'
const KEK = b4a.toString(crypto.randomBytes(32), 'hex')

function home(t, label) {
  const root = tmpDir(label)
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmpDir(label + '-dl')
  t.teardown(() => { for (const dir of [root, downloads]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } }, { order: 3 })
  return { root, storage, downloads }
}

async function start(t, h, { masterSecret = undefined } = {}) {
  const config = { storage: h.storage, appVersion: 't', dev: true, verbose: false, downloadFolder: h.downloads, identityKEK: KEK, localBackupEnabled: true, restoreReleaseDwellMs: 0 }
  setRuntimeConfig(config)
  setDownloadFolder(h.downloads)
  const fake = createFakeIpc()
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, memberRegistry: offlineMemberRegistry, ...(masterSecret ? { masterSecret } : {}) })
  t.teardown(async () => { try { await root.close() } catch {} }, { order: 1 })
  return { root, fake }
}

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

// A device with a profile, a space with a shared file, backed up into `folder`, then closed.
async function backedUpDevice(t, folder) {
  const h = home(t, 'restore-src')
  const { root } = await start(t, h, { masterSecret: crypto.randomBytes(32) })
  await setProfile({ displayName: 'Original' })
  const { spaceId } = await createSpace('Restored Space')
  await advertise(spaceId, 'share-1', 'kept-file.txt', { size: 4, mtime: 1, contentHash: null })
  fs.writeFileSync(path.join(h.root, 'config.json'), JSON.stringify({ appearance: { theme: 'dark' } }))
  const run = await runBackup({ store: getStore(), storagePath: h.storage, target: new FolderTarget(folder), wrapKey: backupWrapKey(), repoId: null, installId: 'old-install', appVersion: 't', config: b4a.from(JSON.stringify({ appearance: { theme: 'dark' } })) })
  const content = await sealRecoveryKey(PASS, { createdAt: '2026-10-01T00:00:00Z' })
  const personKey = b4a.toString(getProfileBee().core.key, 'hex')
  await root.close()
  return { spaceId, content, personKey, snapshot: run.snapshot }
}

// A new device on onboarding: an unused identity whose worker offers the restore.
async function newDevice(t) {
  const h = home(t, 'restore-dst')
  const { root, fake } = await start(t, h, { masterSecret: crypto.randomBytes(32) })
  registerBackupRestore(fake.ipc, { storagePath: h.storage, identityKEK: KEK, log: quiet, lockedBy: null, openRecovery: createPassphraseThrottle() })
  return { h, root, fake }
}

function backupFolder(t) {
  const dir = tmpDir('restore-backup')
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }, { order: 3 })
  return dir
}

test('a backup restores onto a new device: listed, staged, put in place, and held until confirmed', async (t) => {
  const folder = backupFolder(t)
  const original = await backedUpDevice(t, folder)
  const device = await newDevice(t)

  const { snapshots } = await device.fake.call('backup:inspect', { folder, content: original.content, passphrase: PASS })
  t.is(snapshots.length, 1)
  t.is(snapshots[0].name, original.snapshot)
  t.is(snapshots[0].spaces, 1)

  const restored = await device.fake.call('backup:restore', { folder, snapshot: original.snapshot, content: original.content, passphrase: PASS })
  t.alike(restored, { ok: true, settings: JSON.stringify({ appearance: { theme: 'dark' } }) })
  t.ok(fs.existsSync(stagingPath(device.h.storage)))
  t.alike(fs.readdirSync(path.join(folder, REPO_DIR, 'leases')), [], 'the old installation no longer holds the folder')
  await device.root.close()

  const setAside = await applyPendingIdentityChange(device.h.storage)
  t.ok(setAside, 'the unused identity was set aside')
  t.absent(fs.existsSync(stagingPath(device.h.storage)))

  const { root } = await start(t, device.h)
  t.ok(isHeld(PROFILE_BEE), 'the profile is held')
  t.is((await getProfile()).displayName, 'Original', 'the restored profile reads back')
  t.is(b4a.toString(getProfileBee().core.key, 'hex'), original.personKey, 'under the same identity')
  const spaces = await listSpaces()
  t.alike(spaces.map((s) => s.spaceId), [original.spaceId], 'the space list is back')
  const catalogName = catalogNameForSpace(original.spaceId, spaces[0])
  t.ok(isHeld(catalogName), 'and its own catalog is held')

  await waitFor(() => root.restoreCatchUp.status()?.profile?.released, 15000, { interval: 200, label: 'a solo identity is released' })
  t.absent(isHeld(catalogName), 'a space with no other member releases its catalog')
  const catalog = await ownCatalog(original.spaceId)
  t.ok(catalog.core.writable, 'which reopens writable')
  let found = false
  for await (const node of catalog.createReadStream()) if (node.key.includes('kept-file.txt')) found = true
  t.ok(found, 'with the shared file in it')
  t.is(root.backup(), null, 'no backup while the profile is held')
  t.ok(root.backupPaused(), 'which is reported as paused')
  await root.close()

  // A catalog still held on the next boot: the backup waits for it, then starts in the same session.
  await writeRestoreHold(device.h.storage, [catalogName])
  const later = await start(t, device.h)
  await waitFor(() => later.root.backup() !== null, 15000, { interval: 200, label: 'the backup starts once the last hold is released' })
  t.absent(isHeld(catalogName))
  t.absent(later.root.backupPaused(), 'and is no longer paused')
})

test('another identity cannot read the backup', async (t) => {
  const folder = backupFolder(t)
  await backedUpDevice(t, folder)
  const device = await newDevice(t)
  const otherKey = await sealRecoveryKey(PASS, { createdAt: '2026-10-01T00:00:00Z' })
  t.is(await codeOf(device.fake.call('backup:inspect', { folder, content: otherKey, passphrase: PASS })), 'BACKUP_FOREIGN_IDENTITY')
})

test('a backup that does not rebuild is refused before anything is replaced', async (t) => {
  const folder = backupFolder(t)
  const original = await backedUpDevice(t, folder)
  const objects = path.join(folder, REPO_DIR, 'objects')
  const prefix = fs.readdirSync(objects)[0]
  fs.rmSync(path.join(objects, prefix, fs.readdirSync(path.join(objects, prefix))[0]))
  const device = await newDevice(t)
  t.is(await codeOf(device.fake.call('backup:restore', { folder, snapshot: original.snapshot, content: original.content, passphrase: PASS })), 'BACKUP_CORRUPT')
  t.absent(fs.existsSync(path.join(device.h.root, 'restore-pending.json')), 'nothing is waiting for the next boot')
})

test('a restore is refused over an identity in use', async (t) => {
  const folder = backupFolder(t)
  const original = await backedUpDevice(t, folder)
  const device = await newDevice(t)
  await setProfile({ displayName: 'In use' })
  t.is(await codeOf(device.fake.call('backup:restore', { folder, snapshot: original.snapshot, content: original.content, passphrase: PASS })), 'NOT_AUTHORIZED')
})

test('a swap interrupted part-way is finished by the next boot', async (t) => {
  const folder = backupFolder(t)
  const original = await backedUpDevice(t, folder)
  const device = await newDevice(t)
  await device.fake.call('backup:restore', { folder, snapshot: original.snapshot, content: original.content, passphrase: PASS })
  await device.root.close()
  const staging = stagingPath(device.h.storage)
  const { setAsideLockedData } = await import('../../src/shared/core/identity-set-aside.js')
  setAsideLockedData(device.h.storage)
  const first = fs.readdirSync(staging).find((name) => name !== 'CORESTORE')
  fs.renameSync(path.join(staging, first), path.join(device.h.storage, first))

  await applyPendingIdentityChange(device.h.storage)
  t.ok(fs.existsSync(path.join(device.h.storage, 'CORESTORE')))
  t.absent(fs.existsSync(staging))
  t.absent(fs.existsSync(path.join(device.h.root, 'restore-pending.json')))
  await start(t, device.h)
  t.is((await getProfile()).displayName, 'Original')
})

test('setting up the fresh identity drops a restore that never reached a restart', async (t) => {
  const folder = backupFolder(t)
  const original = await backedUpDevice(t, folder)
  const device = await newDevice(t)
  registerProfile(device.fake.ipc, { log: quiet })
  await device.fake.call('backup:restore', { folder, snapshot: original.snapshot, content: original.content, passphrase: PASS })
  await device.fake.call('profile:set', { displayName: 'Kept the new one' })
  t.absent(fs.existsSync(path.join(device.h.root, 'restore-pending.json')))
  t.absent(fs.existsSync(stagingPath(device.h.storage)))
  t.absent(fs.existsSync(path.join(device.h.root, 'identity-adopt.enc')))
  t.is(await applyPendingIdentityChange(device.h.storage), null, 'the next boot has nothing to apply')
})

test('a restore request that cannot be read is dropped, and the device boots as it was', async (t) => {
  const folder = backupFolder(t)
  const original = await backedUpDevice(t, folder)
  const device = await newDevice(t)
  await device.fake.call('backup:restore', { folder, snapshot: original.snapshot, content: original.content, passphrase: PASS })
  await device.root.close()
  fs.writeFileSync(path.join(device.h.root, 'restore-pending.json'), '{"hol')
  t.is(await applyPendingIdentityChange(device.h.storage), null)
  t.absent(fs.existsSync(stagingPath(device.h.storage)))
  t.absent(fs.existsSync(path.join(device.h.root, 'identity-adopt.enc')))
})

test('a snapshot name the backup never wrote is refused as unreadable', async (t) => {
  const folder = backupFolder(t)
  const original = await backedUpDevice(t, folder)
  const device = await newDevice(t)
  t.is(await codeOf(device.fake.call('backup:restore', { folder, snapshot: '../mirall-backup.json', content: original.content, passphrase: PASS })), 'BACKUP_CORRUPT')
})
