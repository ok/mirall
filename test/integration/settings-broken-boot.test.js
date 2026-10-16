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
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getNewSpaceDownloadDir } from '../../src/shared/core/paths.js'

// A settings.json that exists but cannot be used is the user's to repair: the worker runs on
// defaults, and nothing boot does on its own may replace the file. The entry's own sequence runs
// here — the settings file, the assembled config, then the real boot().

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const RELAY_KEY = 'y'.repeat(52)

// A configured user: a relay, bandwidth caps, a backup bound to its repository, a self-hosted link
// base, and recent folders — everything a replaced file would lose.
function userSettings(root) {
  return `{
  "version": 1,
  "downloads": { "folder": "${path.join(root, 'my-downloads')}", "recent": ["/Users/me/A", "/Users/me/B"] },
  "network": { "downloadKBps": 256, "uploadKBps": 32, "relayMode": "auto", "relay": { "publicKey": "${RELAY_KEY}", "kind": "open", "label": "home relay" }, "downloadConcurrency": 6 },
  "backup": { "folder": "${path.join(root, 'backup-drive')}", "repoId": "repo-7f3a" },
  "links": { "baseUrl": "https://console.example.org" }
}
`
}

async function bootOver(t, prepare) {
  const root = tmpDir('settings-broken', t)
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const file = path.join(root, 'settings.json')
  const written = prepare(file, root)
  const bootstrap = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, defaultDownloadFolder: tmpDir('settings-broken-dl', t) }
  const flags = loadFeatureFlags(tmpDir('settings-broken-flags', t), { log: quiet })
  const load = await loadSettings(storage)
  setRuntimeConfig(assembleRuntimeConfig({ bootstrap, settings: getSettings(), flags }))
  const worker = await boot(bootstrap, { ipc: createFakeIpc().ipc, log: quiet, swarm: false, masterSecret: crypto.randomBytes(32), memberRegistry: offlineMemberRegistry })
  t.teardown(async () => { try { await worker.close() } catch {} }, { order: 1 })
  return { file, written, load }
}

test('REGRESSION (FIX-DLTO-R1: boot replaced a settings.json it could not parse): a hand-edit typo comes through boot byte-identical', async (t) => {
  const h = await bootOver(t, (file, root) => {
    const typo = userSettings(root).replace('"https://console.example.org" }', '"https://console.example.org", }')
    fs.writeFileSync(file, typo)
    return typo
  })
  t.ok(h.load.broken, 'precondition: the file could not be parsed')
  t.is(fs.readFileSync(h.file, 'utf-8'), h.written, 'the user\'s file is still there to repair')
  t.ok(getSettings().downloads.recent.includes(getNewSpaceDownloadDir()), 'the recent folders start in memory all the same')
})

test('REGRESSION (FIX-DLTO-R1: boot replaced a settings.json it could not read): an unreadable file comes through boot untouched', async (t) => {
  const h = await bootOver(t, (file, root) => {
    const whole = userSettings(root)
    fs.writeFileSync(file, whole)
    fs.chmodSync(file, 0o000)
    return whole
  })
  t.teardown(() => { try { fs.chmodSync(h.file, 0o600) } catch {} })
  t.ok(h.load.broken, 'precondition: the file could not be read')
  t.is(fs.statSync(h.file).mode & 0o777, 0, 'the file was not replaced')
  fs.chmodSync(h.file, 0o600)
  t.is(fs.readFileSync(h.file, 'utf-8'), h.written)
})
