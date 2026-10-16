// The data layer's persisted settings: the shape of settings.json, what a parsed file may contain,
// and how its groups project onto runtime-config keys. Pure, so the unit suite pins every rule
// under Node; settings-store.js does the I/O.
import { RELAY_MODES } from '../contract/relay-apply.js'
import { DEFAULT_WEB_LINK_BASE } from '../contract/invite-envelope.js'
/** @import { RelayMode, RelaySlot } from '../contract/relay-apply.js' */

export const SETTINGS_VERSION = 1

/**
 * @typedef {{ version: number,
 *   downloads: { folder: string | null, recent: string[] },
 *   network: { downloadKBps: number, uploadKBps: number, relayMode: RelayMode, relay: RelaySlot | null, downloadConcurrency: number },
 *   backup: { folder: string | null, repoId: string | null },
 *   links: { baseUrl: string } }} Settings
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    downloads: { folder: null, recent: [] },
    // downloadConcurrency has no setter and no UI on purpose: it is an operator lever and the
    // rollback path for the shared fetch gate. 0 disables the gate entirely.
    network: { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relay: null, downloadConcurrency: 6 },
    backup: { folder: null, repoId: null },
    // baseUrl has no setter and no UI: a self-hosted Console's link host is set in the file.
    links: { baseUrl: DEFAULT_WEB_LINK_BASE },
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmptyString = (v) => (typeof v === 'string' && v.length > 0 ? v : null)
const countAtLeastZero = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback)
const isAbsolutePath = (v) => typeof v === 'string' && (/^[\\/]/.test(v) || /^[A-Za-z]:[\\/]/.test(v))

// This device's download folders, newest first: absolute paths, each once, at most `limit`.
/** @param {unknown} v @param {number} limit @returns {string[]} */
function recentFolders(v, limit) {
  if (!Array.isArray(v)) return []
  return [...new Set(v.filter(isAbsolutePath))].slice(0, limit)
}

// A folder just used moves to the front; the oldest past `limit` drops out. `same` compares two
// paths the way the host does.
/** @param {string[]} recent @param {string} folder @param {{ limit: number, same: (a: string, b: string) => boolean }} opts */
export function withRecentFolder(recent, folder, { limit, same }) {
  return [folder, ...recent.filter((p) => !same(p, folder))].slice(0, limit)
}

// A link base is an https URL with nothing after the path: a query or fragment would collide with
// the code the link carries in its fragment.
/** @param {unknown} v @param {string} fallback */
function linkBaseOrDefault(v, fallback) {
  if (typeof v !== 'string') return fallback
  let url
  try { url = new URL(v) } catch { return fallback }
  if (url.protocol !== 'https:' || url.search !== '' || url.hash !== '' || v.endsWith('?') || v.endsWith('#')) return fallback
  return v.replace(/\/+$/, '')
}

// Every field is re-derived from the parsed input against the defaults: a hand-edited or truncated
// file yields the default for the field it broke, never a value the worker would refuse.
// `sanitizeRelay` is injected because it decodes the key, which the contract package cannot do;
// `recentLimit` is the app's configured length of the recent-folder list.
/** @param {unknown} raw @param {{ sanitizeRelay: (entry: unknown) => RelaySlot | null, recentLimit: number }} deps @returns {Settings} */
export function coerceSettings(raw, { sanitizeRelay, recentLimit }) {
  const d = defaultSettings()
  const src = isPlainObject(raw) ? raw : {}
  const downloads = isPlainObject(src.downloads) ? src.downloads : {}
  const network = isPlainObject(src.network) ? src.network : {}
  const backup = isPlainObject(src.backup) ? src.backup : {}
  const links = isPlainObject(src.links) ? src.links : {}
  return {
    version: SETTINGS_VERSION,
    downloads: { folder: nonEmptyString(downloads.folder), recent: recentFolders(downloads.recent, recentLimit) },
    network: {
      downloadKBps: countAtLeastZero(network.downloadKBps, d.network.downloadKBps),
      uploadKBps: countAtLeastZero(network.uploadKBps, d.network.uploadKBps),
      relayMode: RELAY_MODES.includes(network.relayMode) ? network.relayMode : 'off',
      relay: sanitizeRelay(network.relay),
      downloadConcurrency: countAtLeastZero(network.downloadConcurrency, d.network.downloadConcurrency),
    },
    backup: { folder: nonEmptyString(backup.folder), repoId: nonEmptyString(backup.repoId) },
    links: { baseUrl: linkBaseOrDefault(links.baseUrl, d.links.baseUrl) },
  }
}

// The first boot without settings.json takes the moved groups from main's config.json as they
// stand; everything else in that file is main's and is left unread.
export function importFromConfig(configJson, deps) {
  const src = isPlainObject(configJson) ? configJson : {}
  return coerceSettings({ downloads: src.downloads, network: src.network, backup: src.backup }, deps)
}

// What a restored backup's settings json changes in the current settings: the bandwidth caps, the
// download folder only when it can be used on this device, never the relay (its seed is bound to
// the device that made the backup) and never the recent folders (paths on that device).
export function applyRestoredSettings(current, json, { folderUsable }) {
  let parsed
  try {
    parsed = JSON.parse(json)
  } catch {
    return current
  }
  if (!isPlainObject(parsed)) return current
  const next = { ...current, network: { ...current.network }, downloads: { ...current.downloads } }
  if (isPlainObject(parsed.network)) {
    const { downloadKBps, uploadKBps } = parsed.network
    if (typeof downloadKBps === 'number') next.network.downloadKBps = downloadKBps
    if (typeof uploadKBps === 'number') next.network.uploadKBps = uploadKBps
  }
  const folder = isPlainObject(parsed.downloads) ? nonEmptyString(parsed.downloads.folder) : null
  if (folder && folderUsable(folder)) next.downloads.folder = folder
  return next
}

export function settingsToRuntimeConfig(s) {
  return {
    downloadFolder: s.downloads.folder,
    downloadKBps: s.network.downloadKBps,
    uploadKBps: s.network.uploadKBps,
    relayMode: s.network.relayMode,
    relay: s.network.relay,
    downloadConcurrency: s.network.downloadConcurrency,
    backupFolder: s.backup.folder,
    backupRepoId: s.backup.repoId,
  }
}
