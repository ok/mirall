import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyRestoredSettings } from '../../src/main/backup-settings.js'
import { ConfigStore } from '../../src/main/config-store.js'

function freshStore(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-backup-settings-'))
  const store = new ConfigStore(dir).load()
  t.teardown(() => {
    store.flush()
    fs.rmSync(dir, { recursive: true, force: true })
  })
  return store
}

test('a restore puts back appearance and notifications, and leaves device choices alone', (t) => {
  const store = freshStore(t)
  const json = JSON.stringify({
    appearance: { theme: 'dark', locale: 'de' },
    notifications: { enabled: false },
    general: { openAtLogin: true, minimizeToTray: false },
    window: { zoom: 2 },
  })
  applyRestoredSettings(json, { store })
  t.is(store.get('appearance.theme'), 'dark')
  t.is(store.get('appearance.locale'), 'de')
  t.alike(store.get('notifications'), { enabled: false })
  t.is(store.get('general.openAtLogin'), false)
  t.is(store.get('general.minimizeToTray'), true)
  t.is(store.get('window.zoom'), 1)
})

test('the worker\'s groups are not written into config.json', (t) => {
  const store = freshStore(t)
  const json = JSON.stringify({ network: { downloadKBps: 500 }, downloads: { folder: '/elsewhere' }, backup: { folder: '/b' } })
  applyRestoredSettings(json, { store })
  t.is(store.get('network'), undefined)
  t.is(store.get('downloads'), undefined)
  t.is(store.get('backup'), undefined)
})

test('an unknown theme is refused by the store', (t) => {
  const store = freshStore(t)
  applyRestoredSettings(JSON.stringify({ appearance: { theme: 'neon' } }), { store })
  t.is(store.get('appearance.theme'), 'system')
})

test('anything that is not a settings object changes nothing', (t) => {
  for (const json of ['not json', '[1,2]', 'null', JSON.stringify({ appearance: 'dark', network: [1] })]) {
    const store = freshStore(t)
    applyRestoredSettings(json, { store })
    t.is(store.get('appearance.theme'), 'system', json)
  }
})
