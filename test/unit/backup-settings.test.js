import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { applyRestoredSettings, registerBackupIpc } from '../../src/main/backup-settings.js'
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

function tmpDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-backup-folder-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  return dir
}

// The two handlers, registered as main registers them, with the picker answering `picked`.
function backupIpc(dataDir, picked = null) {
  const handlers = new Map()
  const ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) }
  registerBackupIpc({ ipcMain, config: () => null, pickDirectory: async () => picked, dataDir: () => dataDir })
  return {
    browse: () => handlers.get('backup:browse')({}, undefined),
    inspect: (folder) => handlers.get('backup:inspect')({}, folder),
  }
}

test('a typed backup folder gets the checks a picked one does', async (t) => {
  const dataDir = tmpDir(t)
  const empty = tmpDir(t)
  const cluttered = tmpDir(t)
  fs.writeFileSync(path.join(cluttered, 'notes.txt'), 'x')
  const ipc = backupIpc(dataDir, empty)
  t.alike(await ipc.inspect(empty), { folder: empty, sameDisk: true, otherFiles: false })
  t.alike(await ipc.inspect(empty), await ipc.browse(), 'typed and picked describe one folder alike')
  t.is((await ipc.inspect(cluttered)).otherFiles, true)
})

test('a typed path that is not an existing folder is no backup folder', async (t) => {
  const dir = tmpDir(t)
  const file = path.join(dir, 'file.txt')
  fs.writeFileSync(file, 'x')
  const ipc = backupIpc(dir)
  for (const typed of [path.join(dir, 'missing'), file, 'relative/folder', '', 42, undefined]) {
    t.is(await ipc.inspect(typed), null, String(typed))
  }
})
