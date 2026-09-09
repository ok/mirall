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
  t.is(store.get('storage.cacheBudgetBytes'), 0)
  const onDisk = readConfig(dir)
  t.is(onDisk.version, CONFIG_VERSION)
  t.is(onDisk.appearance.theme, 'system')
})

test('migrates the five main files plus the cache file, then deletes them', (t) => {
  const dir = tmpDir()
  const storageDir = path.join(dir, 'app-storage')
  writeJson(path.join(dir, 'zoom.json'), { factor: 1.25 })
  writeJson(path.join(dir, 'window-bounds.json'), { x: 10, y: 20, width: 800, height: 600 })
  writeJson(path.join(dir, 'theme.json'), { mode: 'dark' })
  writeJson(path.join(dir, 'app-prefs.json'), { minimizeToTray: false, openAtLogin: true, firstHideNoticeShown: true, appMenuAutoHide: true })
  writeJson(path.join(dir, 'download-settings.json'), { folder: '/tmp/dl' })
  writeJson(path.join(storageDir, 'ondemand-cache.json'), { bytes: 2147483648 })

  const store = new ConfigStore(dir).load()
  t.is(store.get('window.zoom'), 1.25)
  t.alike(store.get('window.bounds'), { x: 10, y: 20, width: 800, height: 600 })
  t.is(store.get('appearance.theme'), 'dark')
  t.is(store.get('general.minimizeToTray'), false)
  t.is(store.get('general.openAtLogin'), true)
  t.is(store.get('general.appMenuAutoHide'), true)
  t.is(store.get('downloads.folder'), '/tmp/dl')
  t.is(store.get('storage.cacheBudgetBytes'), 2147483648)

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
  t.is(store.get('downloads.folder'), null, 'missing download folder defaults')
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
  t.is(store.get('storage.cacheBudgetBytes'), 0, 'missing section gets default')
  t.is(store.get('general.minimizeToTray'), true, 'missing section gets default')
})

test('get/set dot-path round-trips and persists atomically', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.set('window.bounds', { x: 1, y: 2, width: 300, height: 400 })
  store.set('storage.cacheBudgetBytes', 536870912)
  store.flush()
  const onDisk = readConfig(dir)
  t.alike(onDisk.window.bounds, { x: 1, y: 2, width: 300, height: 400 })
  t.is(onDisk.storage.cacheBudgetBytes, 536870912)
  t.absent(fs.existsSync(path.join(dir, 'config.json.tmp')), 'no temp file left behind')

  const reloaded = new ConfigStore(dir).load()
  t.is(reloaded.get('storage.cacheBudgetBytes'), 536870912)
})

test('rendererSnapshot exposes only renderer-facing config', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.set('appearance.locale', 'de')
  const snap = store.rendererSnapshot()
  t.alike(Object.keys(snap).sort(), ['appearance', 'features', 'network', 'notifications', 'ui'])
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

test('network defaults to unlimited and self-heals onto a config written before it existed', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  t.is(store.get('network.downloadKBps'), 0, 'download unlimited by default')
  t.is(store.get('network.uploadKBps'), 0, 'upload unlimited by default')

  // A config.json from a build that predates the network group must gain it via
  // mergeDefaults, without losing what that build did set.
  writeJson(path.join(dir, 'config.json'), { version: CONFIG_VERSION, appearance: { theme: 'dark' } })
  const reopened = new ConfigStore(dir).load()
  t.is(reopened.get('network.downloadKBps'), 0, 'missing group filled with defaults')
  t.is(reopened.get('appearance.theme'), 'dark', 'existing values preserved')
})

// The operator lever for the shared overlay fetch gate. It has no setter and no renderer surface,
// so the only things that can break it are a missing default and a load that drops a hand-set
// value — both of which this pins.
test('the download concurrency default is carried, self-heals and survives a rewrite', (t) => {
  const dir = tmpDir()
  t.is(new ConfigStore(dir).load().get('network.downloadConcurrency'), 6, 'fresh config gets the default')

  writeJson(path.join(dir, 'config.json'), { version: CONFIG_VERSION, network: { downloadKBps: 500 } })
  const healed = new ConfigStore(dir).load()
  t.is(healed.get('network.downloadConcurrency'), 6, 'a config written before the key existed gains it')
  t.is(healed.get('network.downloadKBps'), 500, 'and keeps what that build did set')

  // _migrate re-derives only the relay fields; a hand-set cap must not be reset on the next load,
  // and the rollback value (0 = unlimited) must survive exactly, not be coerced to the default.
  const store = new ConfigStore(dir).load()
  store.set('network.downloadConcurrency', 0)
  store.flush()
  t.is(new ConfigStore(dir).load().get('network.downloadConcurrency'), 0, 'a hand-set 0 survives reload')
})

test('the download concurrency stays out of the renderer snapshot', (t) => {
  const snap = new ConfigStore(tmpDir()).load().rendererSnapshot()
  t.absent('downloadConcurrency' in snap.network, 'no UI by design — exposing it would need an "Unlimited" label for 0')
})

test('setBandwidth stores non-negative integers and ignores anything else', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()

  store.setBandwidth({ downloadKBps: 5120, uploadKBps: 1024 })
  t.is(store.get('network.downloadKBps'), 5120)
  t.is(store.get('network.uploadKBps'), 1024)

  store.setBandwidth({ downloadKBps: 512.7 })
  t.is(store.get('network.downloadKBps'), 512, 'floored to a whole KB/s')

  for (const bad of [-1, NaN, Infinity, '900', null, {}]) {
    store.setBandwidth({ downloadKBps: bad })
    t.is(store.get('network.downloadKBps'), 512, `rejects ${String(bad)}`)
  }

  store.setBandwidth({ uploadKBps: 0 })
  t.is(store.get('network.uploadKBps'), 0, '0 is valid — it means unlimited')

  store.setBandwidth(null)
  t.is(store.get('network.downloadKBps'), 512, 'a non-object patch is a no-op')
})

test('network survives a persist/reload round-trip', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.setBandwidth({ downloadKBps: 2048, uploadKBps: 256 })
  store.flush()
  // Bandwidth, relay and the fetch-gate cap share the `network` group, so the persisted block
  // carries all three.
  t.alike(readConfig(dir).network, { downloadKBps: 2048, uploadKBps: 256, relayMode: 'off', relay: null, downloadConcurrency: 6 })
  const reopened = new ConfigStore(dir).load()
  t.is(reopened.get('network.downloadKBps'), 2048)
  t.is(reopened.get('network.uploadKBps'), 256)
})

// === network / relay block ===

const RELAY_KEY = 'yyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyyy'
const OTHER_KEY = 'usdgj55ym13jkwz7nyrn4tf9yog5ocqhgbzpmiapfunqoj398xqo'

test('network defaults appear on a config.json written before relays existed', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'config.json'), { version: CONFIG_VERSION, appearance: { theme: 'dark' } })
  const store = new ConfigStore(dir).load()
  t.is(store.get('appearance.theme'), 'dark', 'existing values are preserved')
  t.is(store.get('network.relayMode'), 'off')
  t.is(store.get('network.relay'), null)
})

test('the renderer snapshot exposes network and a read-only features group', (t) => {
  const store = new ConfigStore(tmpDir()).load()
  const snap = store.rendererSnapshot()
  t.is(snap.network.relayMode, 'off', 'relays are off until the user configures one')
  t.is(snap.network.relay, null)
  t.alike(snap.features, {}, 'the group survives with no flags in it')
})

// The group is kept deliberately (a future renderer-visible flag), and its value is that main
// stays the only writer. A spread of feature-flags.json would leak every flag; an unguarded
// setRenderer would let the renderer mint one. Neither may become possible by accident, so
// both are asserted while the allowlist is empty.
test('an unknown flag cannot reach the renderer through the features group', (t) => {
  const store = new ConfigStore(tmpDir(), {
    readFeatures: () => ({ relay: true, somethingNew: true }),
  }).load()
  t.alike(store.rendererSnapshot().features, {}, 'only RENDERER_FEATURES entries are exposed')
})

test('setRenderer cannot write a feature flag', (t) => {
  const store = new ConfigStore(tmpDir(), { readFeatures: () => ({}) }).load()
  store.setRenderer({ features: { anything: true } })
  t.alike(store.rendererSnapshot().features, {}, 'the renderer is not a trust boundary')
})

// Not a migration — the relay UI has never been reachable in a shipped build, so no
// config.json in the wild holds a relay to lose. This asserts only that the dead `relays: []`
// every existing file carries is dropped rather than outliving the feature, and that the
// bandwidth caps sharing the group are untouched by the delete.
test('the dead relays array is dropped, and nothing else in the group moves', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'config.json'), {
    version: CONFIG_VERSION,
    network: { downloadKBps: 500, uploadKBps: 128, relayMode: 'off', relays: [], downloadConcurrency: 4 },
  })
  const store = new ConfigStore(dir).load()
  store.flush()

  t.is(store.get('network.relay'), null)
  t.absent('relays' in readConfig(dir).network, 'mergeDefaults would otherwise keep it forever')
  t.is(store.get('network.downloadKBps'), 500)
  t.is(store.get('network.uploadKBps'), 128)
  t.is(store.get('network.downloadConcurrency'), 4, 'the rollback lever survives the delete')
  t.is(readConfig(dir).version, CONFIG_VERSION, 'no version bump — nothing was migrated')
})

// A dev build with the flag forced on could have written rows. Nobody in the wild has them,
// so they are dropped without ceremony — the point is that a stale array cannot crash the
// load or leak into the snapshot.
test('a hand-written relays array is discarded, not folded', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'config.json'), {
    version: CONFIG_VERSION,
    network: { relayMode: 'auto', relays: [{ id: 'a', label: 'Home', publicKey: RELAY_KEY, enabled: true }] },
  })
  const store = new ConfigStore(dir).load()
  t.is(store.get('network.relay'), null, 'no fold, no inherited slot')
  t.is(store.get('network.relayMode'), 'auto', 'the mode is not a relay row and is left alone')
  t.absent('relays' in store.rendererSnapshot().network)
})

test('a config with nothing to clean is not rewritten on load', (t) => {
  const dir = tmpDir()
  const file = path.join(dir, 'config.json')
  writeJson(file, { version: CONFIG_VERSION, network: { downloadKBps: 1, relayMode: 'off', relay: null } })
  const before = fs.statSync(file).mtimeMs
  new ConfigStore(dir).load().flush()
  t.is(fs.statSync(file).mtimeMs, before, 'rewriting every boot to change nothing is worse than waiting')
})

test('setRenderer cannot write the relay slot', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.setRelay('auto', { publicKey: RELAY_KEY, kind: 'open', label: 'kept', enabled: true, lastTest: null })

  store.setRenderer({ network: { relay: { publicKey: OTHER_KEY }, relayMode: 'always' } })
  t.is(store.get('network.relay').publicKey, RELAY_KEY, 'the slot has its own IPC — it also writes a secret')
  t.is(store.get('network.relay').label, 'kept')
  t.is(store.get('network.relayMode'), 'auto')
})

test('setRelay validates the key, the kind and the mode', (t) => {
  const store = new ConfigStore(tmpDir()).load()

  store.setRelay('nonsense', { publicKey: RELAY_KEY })
  t.is(store.get('network.relayMode'), 'off', 'an unknown mode degrades to off')

  store.setRelay('always', { publicKey: 'not-a-key' })
  t.is(store.get('network.relay'), null, 'an undecodable key never reaches relayThrough')
  t.is(store.get('network.relayMode'), 'always')

  const network = store.setRelay('auto', { publicKey: RELAY_KEY, kind: 'private', label: 'club' })
  t.is(network.relay.kind, 'private')
  t.is(network.relay.label, 'club')
  t.is(network.relay.enabled, true)
  t.is(network.relayMode, 'auto', 'the post-write snapshot is what the renderer adopts')

  store.setRelay('auto', null)
  t.is(store.get('network.relay'), null, 'removal clears the slot')
})

test('the renderer snapshot never carries a ticket or a seed', (t) => {
  const store = new ConfigStore(tmpDir()).load()
  store.setRelay('auto', { publicKey: RELAY_KEY, kind: 'private', label: 'club', enabled: true, lastTest: null })
  const snap = JSON.stringify(store.rendererSnapshot())
  t.absent(snap.includes('seed'), 'the member seed lives in relay-ticket.enc, not here')
  t.absent(snap.includes('ticket'))
  t.alike(Object.keys(store.rendererSnapshot().network.relay).sort(),
    ['enabled', 'kind', 'label', 'lastTest', 'publicKey'])
})

test('a hand-edited relay slot is re-sanitized on load', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'config.json'), {
    version: CONFIG_VERSION,
    network: { relayMode: 'sideways', relay: { publicKey: 'garbage', kind: 'private' } },
  })
  const store = new ConfigStore(dir).load()
  t.is(store.get('network.relayMode'), 'off')
  t.is(store.get('network.relay'), null)
})

// config.json now sits beside a member identity: the slot names the relay a person belongs to.
// It also already held the download folder and the feedback email, so 0600 is right regardless.
test('config.json is written owner-only', (t) => {
  const dir = tmpDir()
  const store = new ConfigStore(dir).load()
  store.setRelay('auto', { publicKey: RELAY_KEY })
  store.flush()
  t.is(fs.statSync(path.join(dir, 'config.json')).mode & 0o777, 0o600)
})

// Bandwidth caps and relay config share the `network` group. Each writer must leave
// the other's fields alone — rebuilding the whole block on load silently reset the
// user's transfer limits on every app start.
test('relay and bandwidth coexist in the network group', (t) => {
  const dir = tmpDir()
  writeJson(path.join(dir, 'config.json'), {
    version: CONFIG_VERSION,
    network: { downloadKBps: 4096, uploadKBps: 512, relayMode: 'auto', relay: { publicKey: RELAY_KEY, kind: 'open' } },
  })

  const store = new ConfigStore(dir).load()
  t.is(store.get('network.downloadKBps'), 4096, 'load preserves the bandwidth caps')
  t.is(store.get('network.uploadKBps'), 512)
  t.is(store.get('network.relayMode'), 'auto')

  store.setRelay('always', null)
  t.is(store.get('network.downloadKBps'), 4096, 'a relay write does not clear the caps')
  t.is(store.get('network.uploadKBps'), 512)

  store.setBandwidth({ downloadKBps: 1024 })
  t.is(store.get('network.relayMode'), 'always', 'a bandwidth write does not clear the relay config')

  store.flush()
  const reopened = new ConfigStore(dir).load()
  t.is(reopened.get('network.downloadKBps'), 1024, 'both survive a reload together')
  t.is(reopened.get('network.relayMode'), 'always')

  const snap = reopened.rendererSnapshot().network
  t.alike(Object.keys(snap).sort(), ['downloadKBps', 'relay', 'relayMode', 'uploadKBps'],
    'the snapshot carries the whole group, not just one writer half')
})

// The store is constructed before primeFeatureFlags runs (main.js: readPrefs at app-ready,
// preloadAsarCache six lines later). Latching flags at construction would capture the degraded
// pre-prime read. The allowlist is empty today, so the property is asserted on the thunk
// itself: it must be called per snapshot, not once.
test('feature flags are read lazily, not latched at construction', (t) => {
  let reads = 0
  const store = new ConfigStore(tmpDir(), { readFeatures: () => { reads++; return {} } }).load()

  const before = reads
  store.rendererSnapshot()
  store.rendererSnapshot()
  t.is(reads, before + 2, 'each snapshot re-reads the flags')
})
