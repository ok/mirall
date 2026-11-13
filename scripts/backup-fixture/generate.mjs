// Writes one frozen backup fixture with the code of the release checkout it runs in: a device with a
// fixed test-only identity sets a profile, creates a space with one owned folder, backs up, adds a
// file, backs up again (a delta), and keeps its recovery key in the backup folder. The app's modules
// are imported from the current directory, so the bytes come from that release and its locked
// dependencies. The script must sit inside that checkout, so its own imports resolve there too.
//
// Usage, from the root of a release checkout (see README.md beside this file):
//   node_modules/.bin/bare scripts/backup-fixture/generate.mjs --out <dir> --version <x.y.z>
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import b4a from 'b4a'

// Test-only identity and passphrase: recorded in test/fixtures/backup/SOURCES.md, never a real one.
const MASTER_SECRET = 'mirall-backup-fixture-test-only!'
const IDENTITY_KEK = b4a.toString(b4a.from('mirall-fixture-kek-test-only....'), 'hex')
const PASSPHRASE = 'mirall backup fixture passphrase (test only)'

const PROFILE_NAME = 'Fixture Person'
const SPACE_NAME = 'Fixture Space'
const FOLDER_NAME = 'Project Notes'
const FIRST_FILES = { 'readme.txt': 'Fixture readme.\n', 'todo.txt': 'Nothing to do.\n' }
const ADDED_FILE = { 'changelog.txt': 'Added after the first backup.\n' }
const CARRIED_SETTINGS = { appearance: { theme: 'dark' }, network: { downloadKBps: 333, uploadKBps: 0 }, downloads: { folder: '/Volumes/Gone/Downloads' } }
const FILE_MTIME = Date.parse('2026-10-01T09:00:00.000Z')
const FIRST_RUN_AT = Date.parse('2026-10-01T10:00:00.000Z')
const SECOND_RUN_AT = Date.parse('2026-10-01T11:00:00.000Z')
const KEY_AT = '2026-10-01T11:30:00.000Z'
const INSTALL_ID = 'fixture-install'
// A fixed, neutral path: the mount and the store's own paths end up inside sealed cores.
const WORK = '/tmp/mirall-backup-fixture'

// What differs between releases. A release missing here uses the defaults; add a row only for a
// release whose calls really differ.
const DEFAULTS = Object.freeze({ settingsStore: true })
const ADAPTERS = Object.freeze({
  '1.12.0': { settingsStore: false },
})

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

function parseArgs(argv) {
  const value = (flag) => {
    const i = argv.indexOf(flag)
    return i >= 0 ? argv[i + 1] : undefined
  }
  const out = value('--out')
  const version = value('--version')
  if (!out || !version) throw new Error('usage: bare scripts/backup-fixture/generate.mjs --out <dir> --version <x.y.z>')
  return { out: path.resolve(os.cwd(), out), version }
}

function checkCheckout(cwd, version) {
  const self = decodeURIComponent(new URL(import.meta.url).pathname)
  if (!self.startsWith(cwd + path.sep)) throw new Error(`run from the checkout that holds this script (${self})`)
  const declared = JSON.parse(fs.readFileSync(path.join(cwd, 'package.json'), 'utf-8')).version
  if (declared !== version) throw new Error(`--version ${version} does not match this checkout's package.json (${declared})`)
}

function prepareOut(out) {
  if (fs.existsSync(out) && fs.readdirSync(out).length > 0) throw new Error(`${out} is not empty: a fixture is never regenerated`)
  fs.mkdirSync(out, { recursive: true })
}

const app = (cwd) => (rel) => import('file://' + path.join(cwd, rel))

async function loadModules(cwd, adapter) {
  const load = app(cwd)
  return {
    settings: adapter.settingsStore ? await load('src/shared/core/settings-store.js') : null,
    runtime: await load('src/shared/core/runtime-config.js'),
    boot: await load('src/worker/boot.js'),
    store: await load('src/shared/core/store.js'),
    profile: await load('src/shared/spaces/profile.js'),
    spaces: await load('src/shared/spaces/space-lifecycle.js'),
    shares: await load('src/shared/shares/shares.js'),
    catalog: await load('src/shared/shares/own-catalog.js'),
    mounts: await load('src/shared/folders/mount-store.js'),
    target: await load('src/shared/storage/backup/folder-target.js'),
    run: await load('src/shared/storage/backup/backup-run.js'),
    folderKey: await load('src/shared/storage/backup/folder-key.js'),
    fakeIpc: await load('test/helpers/fake-ipc.js'),
    peers: await load('test/helpers/store.js'),
  }
}

async function bootDevice(m, dirs) {
  const config = { storage: dirs.storage, appVersion: 'fixture', dev: true, verbose: false, downloadFolder: dirs.downloads, identityKEK: IDENTITY_KEK }
  if (m.settings) await m.settings.loadSettings(config.storage)
  m.runtime.setRuntimeConfig(config)
  m.runtime.setDownloadFolder(dirs.downloads)
  return m.boot.boot(config, { ipc: m.fakeIpc.createFakeIpc().ipc, log: quiet, swarm: false, memberRegistry: m.peers.offlineMemberRegistry, masterSecret: b4a.from(MASTER_SECRET) })
}

async function addFiles(m, ctx, files) {
  for (const [name, text] of Object.entries(files)) {
    const file = path.join(ctx.mountPath, name)
    fs.writeFileSync(file, text)
    await m.catalog.advertise(ctx.spaceId, ctx.shareId, name, { size: b4a.byteLength(text), mtime: FILE_MTIME, contentHash: null })
  }
}

function backup(m, { out, version, storage, repoId, at }) {
  return m.run.runBackup({
    store: m.store.getStore(), storagePath: storage, target: new m.target.FolderTarget(out), wrapKey: m.store.backupWrapKey(),
    repoId, installId: INSTALL_ID, appVersion: version, config: b4a.from(JSON.stringify(CARRIED_SETTINGS)), now: () => at,
  })
}

async function populate(m, out, version, dirs) {
  await m.profile.setProfile({ displayName: PROFILE_NAME })
  const { spaceId } = await m.spaces.createSpace(SPACE_NAME)
  const shareId = m.shares.generateShareId()
  await m.shares.publishShare(spaceId, { id: shareId, type: 'owned-folder', name: FOLDER_NAME, contentMode: 'overlay', owner: m.profile.getLocalPublicKeyHex(), createdAt: FILE_MTIME })
  const ctx = { spaceId, shareId, mountPath: path.join(WORK, FOLDER_NAME) }
  fs.mkdirSync(ctx.mountPath, { recursive: true })
  await m.mounts.createOwnedMount({ spaceId, shareId, mountPath: ctx.mountPath, ignore: [], createdAt: FILE_MTIME })
  await addFiles(m, ctx, FIRST_FILES)
  const first = await backup(m, { out, version, storage: dirs.storage, repoId: null, at: FIRST_RUN_AT })
  await addFiles(m, ctx, ADDED_FILE)
  const second = await backup(m, { out, version, storage: dirs.storage, repoId: first.repoId, at: SECOND_RUN_AT })
  if (!first.snapshot || !second.snapshot) throw new Error('a backup run wrote no snapshot')
  const target = new m.target.FolderTarget(out)
  await target.ready()
  const content = await m.store.sealRecoveryKey(PASSPHRASE, { createdAt: KEY_AT })
  await m.folderKey.writeFolderKey(target, { content, createdAt: KEY_AT, identityPub: m.store.ownRecoveryIdentity() })
  return { spaceId, snapshots: [first.snapshot, second.snapshot] }
}

async function main() {
  const cwd = os.cwd()
  const { out, version } = parseArgs(Bare.argv)
  checkCheckout(cwd, version)
  if (fs.existsSync(WORK)) throw new Error(`${WORK} exists: remove it first`)
  prepareOut(out)
  const adapter = { ...DEFAULTS, ...(ADAPTERS[version] ?? {}) }
  const m = await loadModules(cwd, adapter)
  const dirs = { storage: path.join(WORK, 'app-storage'), downloads: path.join(WORK, 'downloads') }
  fs.mkdirSync(dirs.storage, { recursive: true })
  fs.mkdirSync(dirs.downloads, { recursive: true })
  try {
    const root = await bootDevice(m, dirs)
    try {
      const made = await populate(m, out, version, dirs)
      console.log(JSON.stringify({ version, adapter, ...made }))
    } finally {
      await root.close()
    }
  } finally {
    fs.rmSync(WORK, { recursive: true, force: true })
  }
}

main().catch((err) => {
  console.error(err)
  Bare.exitCode = 1
})
