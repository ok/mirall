// A backup written by every release since backups shipped restores on this code. Each directory
// under test/fixtures/backup/ is a frozen backup folder written by the release it is named after
// (scripts/backup-fixture/generate.mjs; provenance in its SOURCES.md), restored here through the
// production path: the folder's recovery key, `backup:inspect`, `backup:restore` (which rebuilds every
// core and checks its length and tree hash), the swap on the next boot, and the restored device's
// own reads. A failure here means this code no longer reads what a release wrote: fix the reader,
// never the fixture.
import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import url from 'bare-url'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { setRuntimeConfig, setDownloadFolder } from '../../src/shared/core/runtime-config.js'
import { loadSettings } from '../../src/shared/core/settings-store.js'
import { boot } from '../../src/worker/boot.js'
import { ownRecoveryIdentity } from '../../src/shared/core/store.js'
import { getProfile, getProfileBee } from '../../src/shared/spaces/profile.js'
import { listSpaces } from '../../src/shared/spaces/space.js'
import { readOwnShares } from '../../src/shared/shares/shares.js'
import { ownCatalog, catalogNameForSpace } from '../../src/shared/shares/own-catalog.js'
import { getOwnedMount } from '../../src/shared/folders/mount-store.js'
import { isHeld, PROFILE_BEE } from '../../src/shared/core/restore-hold.js'
import { applyPendingIdentityChange, stagingPath } from '../../src/shared/core/identity-adopt.js'
import { registerBackupRestore } from '../../src/worker/ipc/backup-restore.js'
import { FolderTarget } from '../../src/shared/storage/backup/folder-target.js'
import { readFolderKey } from '../../src/shared/storage/backup/folder-key.js'
import { openBackup } from '../../src/shared/storage/backup/restore.js'
import { createPassphraseThrottle, openRecoveryFile } from '../../src/shared/core/identity-recovery.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { waitFor } from '../helpers/bare-poll.js'

// What generate.mjs put in every fixture; SOURCES.md records the same values.
const PASS = 'mirall backup fixture passphrase (test only)'
const CARRIED = JSON.stringify({ appearance: { theme: 'dark' }, network: { downloadKBps: 333, uploadKBps: 0 }, downloads: { folder: '/Volumes/Gone/Downloads' } })
const PROFILE_NAME = 'Fixture Person'
const SPACE_NAME = 'Fixture Space'
const FOLDER_NAME = 'Project Notes'
const FILES = ['changelog.txt', 'readme.txt', 'todo.txt']
const MOUNT_PATH = '/tmp/mirall-backup-fixture/Project Notes'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const KEK = b4a.toString(crypto.randomBytes(32), 'hex')
const FIXTURES = path.join(path.dirname(url.fileURLToPath(import.meta.url)), '..', 'fixtures', 'backup')
const RELEASES = fs.readdirSync(FIXTURES).filter((name) => /^\d+\.\d+\.\d+$/.test(name)).sort()

function copyTree(from, to) {
  fs.mkdirSync(to, { recursive: true })
  for (const name of fs.readdirSync(from)) {
    const src = path.join(from, name)
    if (fs.statSync(src).isDirectory()) copyTree(src, path.join(to, name))
    else fs.writeFileSync(path.join(to, name), fs.readFileSync(src))
  }
}

// A restore clears the old installation's lease in the folder, so it runs on a copy.
function fixtureCopy(t, release) {
  const folder = tmpDir('backup-compat-' + release, t)
  copyTree(path.join(FIXTURES, release), folder)
  return folder
}

function home(t) {
  const root = tmpDir('backup-compat-dst')
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmpDir('backup-compat-dl')
  t.teardown(() => { for (const dir of [root, downloads]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} } }, { order: 3 })
  return { root, storage, downloads }
}

async function start(t, h, { masterSecret = undefined } = {}) {
  const config = { storage: h.storage, appVersion: 't', dev: true, verbose: false, downloadFolder: h.downloads, identityKEK: KEK, restoreReleaseDwellMs: 0 }
  await loadSettings(config.storage)
  setRuntimeConfig(config)
  setDownloadFolder(h.downloads)
  const fake = createFakeIpc()
  const root = await boot(config, { ipc: fake.ipc, log: quiet, swarm: false, memberRegistry: offlineMemberRegistry, ...(masterSecret ? { masterSecret } : {}) })
  t.teardown(async () => { try { await root.close() } catch {} }, { order: 1 })
  return { root, fake }
}

// A new device on onboarding: an unused identity whose worker offers the restore.
async function newDevice(t) {
  const h = home(t)
  const { root, fake } = await start(t, h, { masterSecret: crypto.randomBytes(32) })
  registerBackupRestore(fake.ipc, { storagePath: h.storage, identityKEK: () => KEK, log: quiet, lockedBy: () => null, openRecovery: createPassphraseThrottle() })
  return { h, root, fake }
}

// The newest snapshot's manifest, read with the key the folder keeps.
async function newestManifest(folder) {
  const target = new FolderTarget(folder)
  await target.ready()
  const key = await readFolderKey(target)
  const { masterSecret } = await openRecoveryFile(key.content, PASS)
  const repo = await openBackup(folder, masterSecret)
  const [newest] = await repo.listSnapshots()
  return { key, manifest: await repo.readSnapshot(newest) }
}

async function codeOf(promise) {
  try {
    await promise
    return null
  } catch (err) {
    return err.code
  }
}

test('a fixture exists for every release since backups shipped', (t) => {
  t.ok(RELEASES.includes('1.12.0'), 'the first release with backups')
  t.ok(RELEASES.length >= 3, `fixtures: ${RELEASES.join(', ')}`)
})

for (const release of RELEASES) {
  test(`a backup written by ${release} restores onto a new device`, async (t) => {
    const folder = fixtureCopy(t, release)
    const { key, manifest } = await newestManifest(folder)
    t.is(manifest.appVersion, release, 'the snapshot was written by the release its directory names')
    t.ok(manifest.cores.some((core) => core.segments.length >= 2), 'the newest snapshot extends a core with a delta')

    const device = await newDevice(t)
    const { snapshots } = await device.fake.call('backup:inspect', { folder, passphrase: PASS })
    t.is(snapshots.length, 2, 'both snapshots are listed')
    t.alike(snapshots.map((s) => s.appVersion), [release, release])
    t.is(snapshots[0].spaces, 1)

    const restored = await device.fake.call('backup:restore', { folder, snapshot: snapshots[0].name, passphrase: PASS })
    t.alike(restored, { ok: true, settings: CARRIED }, 'every core rebuilt to its recorded length and tree hash, and the settings came back')
    const own = JSON.parse(fs.readFileSync(path.join(device.h.root, 'settings.json'), 'utf-8'))
    t.is(own.network.downloadKBps, 333, 'the carried caps land in the worker\'s settings')
    t.is(own.backup.folder, folder, 'the restored backup is remembered')
    t.alike(fs.readdirSync(path.join(folder, 'leases')), [], 'the old installation no longer holds the folder')
    await device.root.close()

    t.ok(await applyPendingIdentityChange(device.h.storage), 'the unused identity was set aside')
    t.absent(fs.existsSync(stagingPath(device.h.storage)))

    const { root } = await start(t, device.h)
    t.ok(isHeld(PROFILE_BEE), 'the profile is held')
    t.is((await getProfile()).displayName, PROFILE_NAME, 'the profile reads back')
    t.is(ownRecoveryIdentity(), key.identityPub, 'under the identity the folder key names')
    t.is(b4a.toString(getProfileBee().core.key, 'hex'), manifest.cores.find((core) => core.role === 'profile').key, 'with the profile core the backup recorded')
    const spaces = await listSpaces()
    t.alike(spaces.map((s) => s.name), [SPACE_NAME], 'the space is back')
    const { spaceId } = spaces[0]
    const catalogName = catalogNameForSpace(spaceId, spaces[0])
    t.ok(isHeld(catalogName), 'its own catalog is held')
    const shares = await readOwnShares(spaceId)
    t.alike(shares.map((s) => s.name), [FOLDER_NAME], 'the owned folder is shared again')
    t.is((await getOwnedMount(spaceId, shares[0].id))?.mountPath, MOUNT_PATH, 'and mounted where it was')

    await waitFor(() => root.restoreCatchUp.status()?.profile?.released, 15000, { interval: 200, label: 'a solo identity is released' })
    t.absent(isHeld(catalogName), 'a space with no other member releases its catalog')
    const catalog = await ownCatalog(spaceId)
    const names = []
    for await (const node of catalog.createReadStream()) {
      const name = FILES.find((file) => node.key.endsWith(file))
      if (name) names.push(name)
    }
    t.alike(names.sort(), FILES, 'every advertised file is in the catalog, the one added after the first backup too')
  })

  test(`a ${release} backup with a damaged part is refused before anything is replaced`, async (t) => {
    const folder = fixtureCopy(t, release)
    const { manifest } = await newestManifest(folder)
    const part = manifest.cores.find((core) => core.role === 'profile').segments[0].parts[0]
    const file = path.join(folder, 'objects', part.slice(0, 2), part)
    const bytes = fs.readFileSync(file)
    bytes[bytes.byteLength - 1] ^= 0xff
    fs.writeFileSync(file, bytes)

    const device = await newDevice(t)
    const { snapshots } = await device.fake.call('backup:inspect', { folder, passphrase: PASS })
    t.is(await codeOf(device.fake.call('backup:restore', { folder, snapshot: snapshots[0].name, passphrase: PASS })), 'BACKUP_CORRUPT')
    t.absent(fs.existsSync(path.join(device.h.root, 'restore-pending.json')), 'nothing is waiting for the next boot')
  })
}
