import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyRestoredSettings } from '../../src/main/backup-settings.js'
import { ConfigStore } from '../../src/main/config-store.js'

function freshStore(t, opts) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-backup-settings-'))
  const store = new ConfigStore(dir, opts).load()
  t.teardown(() => {
    store.flush()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return store
}

const anywhere = { folderUsable: () => true }

test('a restore puts back appearance and notifications, and leaves device choices alone', (t) => {
  const store = freshStore(t)
  const json = JSON.stringify({
    appearance: { theme: 'dark', locale: 'de' },
    notifications: { enabled: false },
    general: { openAtLogin: true, minimizeToTray: false },
    storage: { cacheBudgetBytes: 1 },
    window: { zoom: 2 },
    backup: { folder: '/elsewhere', repoId: 'r' },
  })
  applyRestoredSettings(json, { store, ...anywhere })
  t.is(store.get('appearance.theme'), 'dark')
  t.is(store.get('appearance.locale'), 'de')
  t.alike(store.get('notifications'), { enabled: false })
  t.is(store.get('general.openAtLogin'), false)
  t.is(store.get('general.minimizeToTray'), true)
  t.is(store.get('storage.cacheBudgetBytes'), 0)
  t.is(store.get('window.zoom'), 1)
  t.is(store.get('backup.folder'), null)
})

test('only valid bandwidth caps travel; the relay stays behind', (t) => {
  const store = freshStore(t)
  const json = JSON.stringify({ network: { downloadKBps: 500, uploadKBps: -3, relayMode: 'auto', relay: { seed: 'x' }, downloadConcurrency: 2 } })
  applyRestoredSettings(json, { store, ...anywhere })
  t.is(store.get('network.downloadKBps'), 500)
  t.is(store.get('network.uploadKBps'), 0)
  t.is(store.get('network.relayMode'), 'off')
  t.is(store.get('network.relay'), null)
  t.is(store.get('network.downloadConcurrency'), 6)
})

test('an unknown theme is refused by the store', (t) => {
  const store = freshStore(t)
  applyRestoredSettings(JSON.stringify({ appearance: { theme: 'neon' } }), { store, ...anywhere })
  t.is(store.get('appearance.theme'), 'system')
})

test('a download folder is kept only when it can be used here', (t) => {
  const json = JSON.stringify({ downloads: { folder: '/Volumes/Old/Downloads' } })
  const refused = freshStore(t)
  applyRestoredSettings(json, { store: refused, folderUsable: () => false })
  t.is(refused.get('downloads.folder'), null)
  const kept = freshStore(t)
  applyRestoredSettings(json, { store: kept, folderUsable: (folder) => folder === '/Volumes/Old/Downloads' })
  t.is(kept.get('downloads.folder'), '/Volumes/Old/Downloads')
})

test('anything that is not a settings object changes nothing', (t) => {
  for (const json of ['not json', '[1,2]', 'null', JSON.stringify({ appearance: 'dark', network: [1] })]) {
    const store = freshStore(t)
    applyRestoredSettings(json, { store, ...anywhere })
    t.is(store.get('appearance.theme'), 'system', json)
    t.is(store.get('network.downloadKBps'), 0, json)
  }
})

test('the renderer snapshot carries the flags it was built with', (t) => {
  const store = freshStore(t, { features: { localBackup: true } })
  t.alike(store.rendererSnapshot().features, { localBackup: true })
  store.setRenderer({ ui: { lastSeenVersion: '1.0.0' } })
  t.alike(store.rendererSnapshot().features, { localBackup: true }, 'a write does not drop it')
})
