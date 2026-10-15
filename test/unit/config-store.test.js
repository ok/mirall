import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { ConfigStore, CONFIG_VERSION } from '../../src/main/config-store.js'

function tmpDir() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-config-'))
}

function writeJson(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj))
}

function readConfig(dir) {
  return JSON.parse(fs.readFileSync(path.join(dir, 'config.json'), 'utf-8'))
}

test('fresh install writes config.json with defaults', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  t.is(store.get('appearance.theme'), 'system')
  t.is(store.get('window.zoom'), 1)
  t.is(store.get('general.minimizeToTray'), true)
  const onDisk = readConfig(dir)
  t.is(onDisk.version, CONFIG_VERSION)
  t.is(onDisk.appearance.theme, 'system')
  t.alike(Object.keys(onDisk).sort(), ['appearance', 'general', 'notifications', 'ui', 'version', 'window'],
    'the worker\'s groups are not written here')
})

test('migrates the five main files plus the cache file, then deletes them', (t) => {
  const dir = tmpDir()
  const storageDir = path.join(dir, 'app-storage')
  writeJson(path.join(dir, 'download-settings.json'), { folder: '/tmp/dl' })
  writeJson(path.join(storageDir, 'ondemand-cache.json'), { bytes: 2147483648 })
  writeJson(path.join(dir, 'zoom.json'), { factor: 1.25 })
  writeJson(path.join(dir, 'window-bounds.json'), { x: 10, y: 20, width: 800, height: 600 })
  writeJson(path.join(dir, 'theme.json'), { mode: 'dark' })
  writeJson(path.join(dir, 'app-prefs.json'), { minimizeToTray: false, openAtLogin: true, firstHideNoticeShown: true, appMenuAutoHide: true })

  const store = new ConfigStore(dir).load()
  t.is(store.get('window.zoom'), 1.25)
  t.alike(store.get('window.bounds'), { x: 10, y: 20, width: 800, height: 600 })
  t.is(store.get('appearance.theme'), 'dark')
  t.is(store.get('general.minimizeToTray'), false)
  t.is(store.get('general.openAtLogin'), true)
  t.is(store.get('general.appMenuAutoHide'), true)

  t.alike(readConfig(dir).downloads, { folder: '/tmp/dl' }, 'the download folder is written where the worker imports it from')
  t.absent('storage' in readConfig(dir), 'the cache budget has no reader left')

  for (const name of ['zoom.json', 'window-bounds.json', 'theme.json', 'app-prefs.json', 'download-settings.json']) {
    t.absent(fs.existsSync(path.join(dir, name)), name + ' deleted')
  }
  t.absent(fs.existsSync(path.join(storageDir, 'ondemand-cache.json')), 'cache file deleted')
  t.ok(fs.existsSync(path.join(dir, 'config.json')), 'config.json written')
})

test('partial legacy: present values imported, missing fall back to defaults', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'theme.json'), { mode: 'light' })
  const store = new ConfigStore(dir).load()
  t.is(store.get('appearance.theme'), 'light')
  t.is(store.get('window.zoom'), 1, 'missing zoom defaults')
})

test('migration is idempotent and config.json wins over reintroduced legacy files', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'theme.json'), { mode: 'dark' })
  new ConfigStore(dir).load()
  // A stale legacy file reappearing must be ignored once config.json exists.
  writeJson(path.join(dir, 'theme.json'), { mode: 'light' })
  const second = new ConfigStore(dir).load()
  t.is(second.get('appearance.theme'), 'dark', 'config.json is authoritative')
  t.ok(fs.existsSync(path.join(dir, 'theme.json')), 'second load does not re-run cleanup')
})

test('corrupt config.json falls back to defaults without throwing', (t) => {
  const dir = tmpDir()
  fs.writeFileSync(path.join(dir, 'config.json'), '{ this is not json')
  const store = new ConfigStore(dir).load()
  t.is(store.get('appearance.theme'), 'system')
  t.ok(fs.existsSync(path.join(dir, 'config.json')))
})

test('merge-on-read self-heals a config missing a newer section', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'config.json'), { version: 1, appearance: { theme: 'dark' } })
  const store = new ConfigStore(dir).load()
  t.is(store.get('appearance.theme'), 'dark', 'stored value preserved')
  t.is(store.get('general.minimizeToTray'), true, 'missing section gets default')
  t.is(store.get('ui.feedbackEmail'), '', 'missing section gets default')
})

test('get/set dot-path round-trips and persists atomically', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.set('window.bounds', { x: 1, y: 2, width: 300, height: 400 })
  store.set('ui.lastSeenVersion', '1.2.3')
  store.flush()
  const onDisk = readConfig(dir)
  t.alike(onDisk.window.bounds, { x: 1, y: 2, width: 300, height: 400 })
  t.is(onDisk.ui.lastSeenVersion, '1.2.3')
  t.absent(fs.existsSync(path.join(dir, 'config.json.tmp')), 'no temp file left behind')

  const reloaded = new ConfigStore(dir).load()
  t.is(reloaded.get('ui.lastSeenVersion'), '1.2.3')
})

test('rendererSnapshot exposes only renderer-facing config', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.set('appearance.locale', 'de')
  const snap = store.rendererSnapshot()
  t.alike(Object.keys(snap).sort(), ['appearance', 'notifications', 'ui'])
  t.is(snap.appearance.theme, 'system')
  t.is(snap.appearance.locale, 'de')
  t.is(snap.ui.feedbackEmail, '')
  t.is(snap.notifications, null)
})

test('setRenderer applies valid patches and rejects bad values', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.setRenderer({ appearance: { theme: 'dark', locale: 'fr' }, ui: { feedbackEmail: 'a@b.c' } })
  t.is(store.get('appearance.theme'), 'dark')
  t.is(store.get('appearance.locale'), 'fr')
  t.is(store.get('ui.feedbackEmail'), 'a@b.c')

  store.setRenderer({ appearance: { theme: 'rainbow' }, ui: { feedbackEmail: 123 } })
  t.is(store.get('appearance.theme'), 'dark', 'invalid theme ignored')
  t.is(store.get('ui.feedbackEmail'), 'a@b.c', 'non-string feedback email ignored')

  store.setRenderer({ notifications: { enabled: false } })
  t.alike(store.get('notifications'), { enabled: false })
  store.setRenderer({ notifications: null })
  t.is(store.get('notifications'), null)
})

// === the groups that moved to the worker's settings.json ===

const MOVED = {
  downloads: { folder: '/tmp/dl' },
  network: { downloadKBps: 500, uploadKBps: 128, relayMode: 'auto', relay: null, downloadConcurrency: 4 },
  backup: { folder: '/tmp/backup', repoId: 'r1' },
  storage: { cacheBudgetBytes: 1 },
}

test('the moved groups are kept, unread, until the worker has written settings.json', (t) => {
  const dir = tmpDir()
  const file = path.join(dir, 'config.json')
  writeJson(file, { version: CONFIG_VERSION, appearance: { theme: 'dark' }, ...MOVED })
  const before = fs.statSync(file).mtimeMs
  const store = new ConfigStore(dir).load()
  store.flush()
  t.is(fs.statSync(file).mtimeMs, before, 'nothing to drop yet, so the file is not rewritten')
  t.alike(readConfig(dir).downloads, MOVED.downloads, 'the worker still has to import this')
  t.alike(readConfig(dir).network, MOVED.network)
  t.alike(readConfig(dir).backup, MOVED.backup)
  t.is(store.get('appearance.theme'), 'dark')
})

test('the moved groups are dropped once settings.json exists beside config.json', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'config.json'), { version: CONFIG_VERSION, appearance: { theme: 'dark' }, ...MOVED })
  writeJson(path.join(dir, 'settings.json'), { version: 1 })
  const store = new ConfigStore(dir).load()
  store.flush()
  const onDisk = readConfig(dir)
  for (const group of Object.keys(MOVED)) t.absent(group in onDisk, group + ' dropped')
  t.is(onDisk.appearance.theme, 'dark', 'the host\'s groups are untouched')
  t.is(store.get('downloads.folder'), undefined, 'and not readable either')
})

test('a config with nothing to clean is not rewritten on load', (t) => {
  const dir = tmpDir()
  const file = path.join(dir, 'config.json')
  writeJson(file, { version: CONFIG_VERSION, appearance: { theme: 'dark' } })
  writeJson(path.join(dir, 'settings.json'), { version: 1 })
  const before = fs.statSync(file).mtimeMs
  new ConfigStore(dir).load().flush()
  t.is(fs.statSync(file).mtimeMs, before, 'rewriting every boot to change nothing is worse than waiting')
})

// config.json holds the feedback email and sits beside a member identity, so 0600 is right.
test('config.json is written owner-only', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.set('ui.feedbackEmail', 'a@b.c')
  store.flush()
  t.is(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
})
