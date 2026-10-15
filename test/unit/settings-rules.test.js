import test from 'brittle'
import {
  SETTINGS_VERSION, defaultSettings, coerceSettings, importFromConfig, settingsToRuntimeConfig, applyRestoredSettings,
} from '../../src/shared/core/settings-rules.js'
import { sanitizeRelay } from '../../src/shared/network/relay-slot.js'

const deps = { sanitizeRelay }
const RELAY_KEY = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'

test('the defaults carry every group with its version', (t) => {
  const d = defaultSettings()
  t.is(d.version, SETTINGS_VERSION)
  t.alike(Object.keys(d).sort(), ['backup', 'downloads', 'links', 'network', 'version'])
  t.alike(d.network, { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relay: null, downloadConcurrency: 6 })
  t.alike(d.downloads, { folder: null })
  t.alike(d.backup, { folder: null, repoId: null })
  t.alike(d.links, { baseUrl: 'https://link.mirall.app' })
})

test('coerceSettings yields the default for every field a broken file loses', (t) => {
  for (const raw of [null, undefined, [], 'x', 42, { downloads: 'x', network: [1], backup: null }]) {
    t.alike(coerceSettings(raw, deps), defaultSettings(), 'garbage: ' + JSON.stringify(raw))
  }
  const s = coerceSettings({
    version: 99,
    downloads: { folder: '' },
    network: { downloadKBps: -5, uploadKBps: 512.7, relayMode: 'sideways', relay: { publicKey: 'garbage' }, downloadConcurrency: -1 },
    backup: { folder: 7, repoId: '' },
  }, deps)
  t.is(s.version, SETTINGS_VERSION, 'the version is this build\'s, whatever the file said')
  t.is(s.downloads.folder, null, 'an empty folder is unset')
  t.is(s.network.downloadKBps, 0, 'a negative cap falls back')
  t.is(s.network.uploadKBps, 512, 'a fractional cap is floored')
  t.is(s.network.relayMode, 'off', 'an unknown mode is off')
  t.is(s.network.relay, null, 'an undecodable key never reaches the swarm')
  t.is(s.network.downloadConcurrency, 6, 'a negative concurrency falls back')
  t.is(s.backup.folder, null)
  t.is(s.backup.repoId, null)
})

test('coerceSettings keeps what is valid, including the 0 that means unlimited', (t) => {
  const s = coerceSettings({
    downloads: { folder: '/tmp/dl' },
    network: { downloadKBps: 2048, uploadKBps: 0, relayMode: 'auto', relay: { publicKey: RELAY_KEY, kind: 'private', label: 'club' }, downloadConcurrency: 0 },
    backup: { folder: '/tmp/b', repoId: 'r1' },
  }, deps)
  t.is(s.downloads.folder, '/tmp/dl')
  t.is(s.network.downloadKBps, 2048)
  t.is(s.network.uploadKBps, 0)
  t.is(s.network.relayMode, 'auto')
  t.alike(s.network.relay, { publicKey: RELAY_KEY, kind: 'private', label: 'club', enabled: true, lastTest: null })
  t.is(s.network.downloadConcurrency, 0, '0 disables the gate and survives')
  t.alike(s.backup, { folder: '/tmp/b', repoId: 'r1' })
})

test('importFromConfig takes exactly the moved groups and leaves the rest unread', (t) => {
  const config = {
    version: 1,
    window: { bounds: null, zoom: 1.5 },
    appearance: { theme: 'dark', locale: 'de' },
    general: { minimizeToTray: false },
    downloads: { folder: '/tmp/dl' },
    network: { downloadKBps: 500, uploadKBps: 128, relayMode: 'always', relay: { publicKey: RELAY_KEY, kind: 'open' }, downloadConcurrency: 4 },
    storage: { cacheBudgetBytes: 1 },
    backup: { folder: '/tmp/b', repoId: 'r' },
    notifications: { enabled: false },
    ui: { feedbackEmail: 'a@b.c' },
  }
  const s = importFromConfig(config, deps)
  t.is(s.downloads.folder, '/tmp/dl')
  t.is(s.network.downloadKBps, 500)
  t.is(s.network.relayMode, 'always')
  t.is(s.network.relay.publicKey, RELAY_KEY)
  t.is(s.network.downloadConcurrency, 4, 'the operator lever survives the import')
  t.alike(s.backup, { folder: '/tmp/b', repoId: 'r' })
  t.alike(Object.keys(s).sort(), ['backup', 'downloads', 'links', 'network', 'version'], 'nothing of main\'s comes along')
  t.is(s.links.baseUrl, 'https://link.mirall.app', 'the links base is the worker\'s own, never read from config.json')
  t.alike(importFromConfig({ version: 1, appearance: { theme: 'dark' } }, deps), defaultSettings(), 'a config without the groups imports defaults')
  t.alike(importFromConfig(null, deps), defaultSettings(), 'no config at all imports defaults')
})

test('settingsToRuntimeConfig names every projected key and nothing else', (t) => {
  const projected = settingsToRuntimeConfig(defaultSettings())
  t.alike(Object.keys(projected).sort(),
    ['backupFolder', 'backupRepoId', 'downloadConcurrency', 'downloadFolder', 'downloadKBps', 'relay', 'relayMode', 'uploadKBps'])
  const s = coerceSettings({ downloads: { folder: '/x' }, network: { relayMode: 'auto' }, backup: { repoId: 'r' } }, deps)
  const p = settingsToRuntimeConfig(s)
  t.is(p.downloadFolder, '/x')
  t.is(p.relayMode, 'auto')
  t.is(p.backupRepoId, 'r')
})

test('applyRestoredSettings takes the caps and a usable folder, never the relay', (t) => {
  const current = coerceSettings({
    network: { relayMode: 'auto', relay: { publicKey: RELAY_KEY, kind: 'private' }, downloadConcurrency: 3 },
  }, deps)
  const json = JSON.stringify({
    appearance: { theme: 'dark' },
    downloads: { folder: '/Volumes/Old/Downloads' },
    network: { downloadKBps: 500, uploadKBps: 'x', relayMode: 'off', relay: null, downloadConcurrency: 9 },
  })
  const kept = applyRestoredSettings(current, json, { folderUsable: () => true })
  t.is(kept.network.downloadKBps, 500)
  t.is(kept.network.uploadKBps, 0, 'a cap that is not a number is left alone')
  t.is(kept.network.relayMode, 'auto', 'the relay stays this device\'s')
  t.is(kept.network.relay.publicKey, RELAY_KEY)
  t.is(kept.network.downloadConcurrency, 3, 'and so does the operator lever')
  t.is(kept.downloads.folder, '/Volumes/Old/Downloads')
  t.is(kept.backup, current.backup, 'the backup bookkeeping is untouched')

  const refused = applyRestoredSettings(current, json, { folderUsable: () => false })
  t.is(refused.downloads.folder, null, 'a folder that cannot be used here is not kept')
  t.is(refused.network.downloadKBps, 500, 'the caps still travel')

  for (const bad of ['not json', '[1]', 'null', 'null']) {
    t.is(applyRestoredSettings(current, bad, { folderUsable: () => true }), current, 'unchanged for ' + bad)
  }
  t.is(applyRestoredSettings(current, null, { folderUsable: () => true }), current, 'a backup with no settings changes nothing')
})
