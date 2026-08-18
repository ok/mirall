// Unified persistent app config: one config.json in the Electron userData dir.
// Main is the only writer — the renderer reads a snapshot synchronously at boot
// and sends patches over IPC. Writes are debounced and atomic (temp file +
// fsync + rename), so a crash never leaves a truncated config behind.
const fs = require('fs')
const path = require('path')
const { normalizeRelayMode, sanitizeRelays } = require('./relay-keys.js')

const CONFIG_FILENAME = 'config.json'
const CONFIG_VERSION = 1
const PERSIST_DEBOUNCE_MS = 250

// Older releases wrote each setting to its own file (these five main-process
// files plus the worker's cache-budget file). The first load folds them into
// config.json once and deletes them.
const LEGACY_MAIN_FILES = ['zoom.json', 'window-bounds.json', 'theme.json', 'app-prefs.json', 'download-settings.json']
const LEGACY_CACHE_FILE = 'ondemand-cache.json'

function defaults() {
  return {
    version: CONFIG_VERSION,
    window: { bounds: null, zoom: 1 },
    appearance: { theme: 'system', locale: null },
    general: { minimizeToTray: true, openAtLogin: false, firstHideNoticeShown: false, appMenuAutoHide: false },
    downloads: { folder: null },
    // Shared group: bandwidth caps and relay configuration both live here.
    network: { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relays: [] },
    storage: { cacheBudgetBytes: 0 },
    notifications: null,
    ui: { lastSeenVersion: null, feedbackEmail: '' },
  }
}

function isPlainObject(v) {
  return typeof v === 'object' && v !== null && !Array.isArray(v)
}

// Overlay stored values onto the default tree so a config written by an older
// version self-heals: keys it never knew about appear with their defaults while
// the values it did set are preserved.
function mergeDefaults(base, override) {
  const out = { ...base }
  for (const key of Object.keys(override)) {
    const next = override[key]
    out[key] = isPlainObject(next) && isPlainObject(out[key]) ? mergeDefaults(out[key], next) : next
  }
  return out
}

function readJson(file) {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8'))
    return isPlainObject(parsed) ? parsed : null
  } catch {
    return null
  }
}

class ConfigStore {
  constructor(dataDir, opts = {}) {
    this._dataDir = dataDir
    this._storageDir = opts.storageDir || path.join(dataDir, 'app-storage')
    this._file = path.join(dataDir, CONFIG_FILENAME)
    this._data = defaults()
    // A thunk, not a value: the store is constructed before primeFeatureFlags runs, so
    // latching the flag here would capture the degraded lazy-read result and could
    // disagree with the copy the worker gets from the primed cache.
    this._readFeatures = opts.readFeatures || (() => ({ relay: false }))
    this._dirty = false
    this._timer = null
  }

  load() {
    const stored = readJson(this._file)
    if (stored) {
      this._data = this._migrate(mergeDefaults(defaults(), stored))
      return this
    }
    this._data = this._importLegacy()
    // Persist durably before touching the per-setting files, so a crash
    // mid-migration can never leave both the unified file and the originals gone.
    this._writeSync()
    this._deleteLegacy()
    return this
  }

  // A config.json can be hand-edited or written by a build with different validation,
  // so the network block is re-sanitized on every load rather than trusted.
  _migrate(data) {
    data.version = CONFIG_VERSION
    // Only the relay fields are re-derived — the bandwidth caps sharing this group
    // must survive untouched. Rebuilding the whole block would silently reset them
    // on every load.
    if (!isPlainObject(data.network)) data.network = defaults().network
    data.network.relayMode = normalizeRelayMode(data.network.relayMode)
    data.network.relays = sanitizeRelays(data.network.relays)
    return data
  }

  _importLegacy() {
    const data = defaults()
    const zoom = readJson(path.join(this._dataDir, 'zoom.json'))
    if (zoom && typeof zoom.factor === 'number') data.window.zoom = zoom.factor
    const bounds = readJson(path.join(this._dataDir, 'window-bounds.json'))
    if (bounds && typeof bounds.x === 'number' && typeof bounds.y === 'number' &&
        typeof bounds.width === 'number' && typeof bounds.height === 'number') {
      data.window.bounds = { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    }
    const theme = readJson(path.join(this._dataDir, 'theme.json'))
    if (theme && (theme.mode === 'light' || theme.mode === 'dark' || theme.mode === 'system')) {
      data.appearance.theme = theme.mode
    }
    const prefs = readJson(path.join(this._dataDir, 'app-prefs.json'))
    if (prefs) {
      for (const key of Object.keys(data.general)) {
        if (typeof prefs[key] === 'boolean') data.general[key] = prefs[key]
      }
    }
    const dl = readJson(path.join(this._dataDir, 'download-settings.json'))
    if (dl && typeof dl.folder === 'string' && dl.folder.length > 0) data.downloads.folder = dl.folder
    const cache = readJson(path.join(this._storageDir, LEGACY_CACHE_FILE))
    if (cache && typeof cache.bytes === 'number') data.storage.cacheBudgetBytes = cache.bytes
    return data
  }

  _deleteLegacy() {
    for (const name of LEGACY_MAIN_FILES) {
      try { fs.rmSync(path.join(this._dataDir, name), { force: true }) } catch {}
    }
    try { fs.rmSync(path.join(this._storageDir, LEGACY_CACHE_FILE), { force: true }) } catch {}
  }

  get(keyPath) {
    let cur = this._data
    for (const part of keyPath.split('.')) {
      if (!isPlainObject(cur)) return undefined
      cur = cur[part]
    }
    return cur
  }

  set(keyPath, value) {
    const parts = keyPath.split('.')
    let cur = this._data
    for (let i = 0; i < parts.length - 1; i++) {
      if (!isPlainObject(cur[parts[i]])) cur[parts[i]] = {}
      cur = cur[parts[i]]
    }
    cur[parts[parts.length - 1]] = value
    this._schedule()
  }

  // `features` is read-only by construction: it has no counterpart in setRenderer, so
  // the renderer can observe a flag but never write one.
  rendererSnapshot() {
    const d = this._data
    return {
      appearance: { theme: d.appearance.theme, locale: d.appearance.locale },
      notifications: d.notifications,
      ui: { lastSeenVersion: d.ui.lastSeenVersion, feedbackEmail: d.ui.feedbackEmail },
      network: {
        downloadKBps: d.network.downloadKBps,
        uploadKBps: d.network.uploadKBps,
        relayMode: d.network.relayMode,
        relays: d.network.relays.map((r) => ({ ...r })),
      },
      features: { relay: this._readFeatures().relay === true },
    }
  }

  // Non-negative finite KB/s only; 0 means unlimited. Anything else leaves the stored
  // value untouched rather than persisting a cap the worker would reject anyway.
  setBandwidth(patch) {
    if (!isPlainObject(patch)) return this._data.network
    for (const key of ['downloadKBps', 'uploadKBps']) {
      const next = patch[key]
      if (typeof next === 'number' && Number.isFinite(next) && next >= 0) {
        this._data.network[key] = Math.floor(next)
      }
    }
    this._schedule()
    return this._data.network
  }

  setRenderer(patch) {
    if (!isPlainObject(patch)) return
    if (isPlainObject(patch.appearance)) {
      const { theme, locale } = patch.appearance
      if (theme === 'light' || theme === 'dark' || theme === 'system') this._data.appearance.theme = theme
      if (typeof locale === 'string') this._data.appearance.locale = locale
    }
    if (patch.notifications === null || isPlainObject(patch.notifications)) {
      this._data.notifications = patch.notifications
    }
    if (isPlainObject(patch.ui)) {
      const { lastSeenVersion, feedbackEmail } = patch.ui
      if (typeof lastSeenVersion === 'string') this._data.ui.lastSeenVersion = lastSeenVersion
      if (typeof feedbackEmail === 'string') this._data.ui.feedbackEmail = feedbackEmail
    }
    if (isPlainObject(patch.network)) {
      const { relayMode, relays } = patch.network
      if (relayMode !== undefined) this._data.network.relayMode = normalizeRelayMode(relayMode)
      // The whole array is replaced, never merged — mergeDefaults treats arrays as
      // opaque, so every add / remove / toggle must send the complete list.
      if (relays !== undefined) this._data.network.relays = sanitizeRelays(relays)
    }
    this._schedule()
  }

  _schedule() {
    this._dirty = true
    if (this._timer) return
    this._timer = setTimeout(() => { this._timer = null; this.flush() }, PERSIST_DEBOUNCE_MS)
    this._timer.unref?.()
  }

  flush() {
    if (this._timer) { clearTimeout(this._timer); this._timer = null }
    if (!this._dirty) return
    this._dirty = false
    this._writeSync()
  }

  // Atomic: write a sibling temp file, fsync it, then rename over the target so
  // a crash can never truncate config.json — a reader sees either the old whole
  // file or the new whole file.
  _writeSync() {
    const tmp = this._file + '.tmp'
    try {
      fs.mkdirSync(this._dataDir, { recursive: true })
      const fd = fs.openSync(tmp, 'w')
      try {
        fs.writeSync(fd, JSON.stringify(this._data, null, 2))
        fs.fsyncSync(fd)
      } finally {
        fs.closeSync(fd)
      }
      fs.renameSync(tmp, this._file)
    } catch (err) {
      console.error('config write failed:', err && err.message ? err.message : err)
    }
  }
}

module.exports = { ConfigStore, CONFIG_VERSION }
