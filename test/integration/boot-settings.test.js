import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { tmpDir } from '../helpers/bare-tmp.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { offlineMemberRegistry } from '../helpers/store.js'
import { boot } from '../../src/worker/boot.js'
import { loadSettings, getSettings } from '../../src/shared/core/settings-store.js'
import { loadFeatureFlags } from '../../src/shared/core/feature-flags.js'
import { assembleRuntimeConfig } from '../../src/shared/core/runtime-config-sources.js'
import { setRuntimeConfig, getRelayConfig, getBandwidthLimits, getBackupConfig, getDownloadConcurrency } from '../../src/shared/core/runtime-config.js'
import { getGlobalDownloadDir } from '../../src/shared/core/paths.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const RELAY_KEY = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'

// The entry's own sequence: flags, then the settings file, then the assembled config, then boot.
async function bootLike(t, { bootstrap, seeded = null, flagsRoot = null }) {
  const root = tmpDir('boot-settings', t)
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  if (seeded) fs.writeFileSync(path.join(root, 'settings.json'), JSON.stringify(seeded))
  const full = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, ...bootstrap }
  const flags = loadFeatureFlags(flagsRoot ?? tmpDir('boot-flags', t), { log: quiet })
  await loadSettings(storage)
  setRuntimeConfig(assembleRuntimeConfig({ bootstrap: full, settings: getSettings(), flags }))
  const fake = createFakeIpc()
  const worker = await boot(full, { ipc: fake.ipc, log: quiet, swarm: false, masterSecret: crypto.randomBytes(32), memberRegistry: offlineMemberRegistry })
  t.teardown(async () => { try { await worker.close() } catch {} }, { order: 1 })
  return { root, storage, worker, fake }
}

test('a seeded settings.json reaches every getter the data layer reads', async (t) => {
  const seeded = {
    version: 1,
    downloads: { folder: tmpDir('boot-dl', t) },
    network: { downloadKBps: 256, uploadKBps: 32, relayMode: 'auto', relay: { publicKey: RELAY_KEY, kind: 'open', label: 'x' }, downloadConcurrency: 2 },
    backup: { folder: null, repoId: null },
  }
  await bootLike(t, { bootstrap: { defaultDownloadFolder: '/tmp/default-dl' }, seeded })
  t.is(path.resolve(getGlobalDownloadDir()), path.resolve(seeded.downloads.folder))
  t.alike(getBandwidthLimits(), { download: 256 * 1024, upload: 32 * 1024 })
  t.is(getRelayConfig().mode, 'auto')
  t.is(getRelayConfig().relay.publicKey, RELAY_KEY)
  t.is(getDownloadConcurrency(), 2)
  t.alike(getBackupConfig(), { folder: null, repoId: null })
})

test('with nothing stored the host default decides the download folder, and the file appears', async (t) => {
  const h = await bootLike(t, { bootstrap: { defaultDownloadFolder: '/tmp/default-dl' } })
  t.is(getGlobalDownloadDir(), '/tmp/default-dl')
  t.ok(fs.existsSync(path.join(h.root, 'settings.json')))
})

test('a bootstrap lever beats the stored value for that run only', async (t) => {
  const seeded = { version: 1, downloads: { folder: '/tmp/stored' }, network: { downloadKBps: 256, uploadKBps: 0, relayMode: 'off', relay: null, downloadConcurrency: 6 }, backup: { folder: null, repoId: null } }
  const h = await bootLike(t, { bootstrap: { downloadFolder: '/tmp/override', downloadKBps: 1 }, seeded })
  t.is(getGlobalDownloadDir(), '/tmp/override')
  t.is(getBandwidthLimits().download, 1024)
  t.is(JSON.parse(fs.readFileSync(path.join(h.root, 'settings.json'), 'utf-8')).downloads.folder, '/tmp/stored', 'the file is untouched')
})
