// The data layer's persisted settings: the shape of settings.json, what a parsed file may contain,
// and how its groups project onto runtime-config keys. Pure, so the unit suite pins every rule
// under Node; settings-store.js does the I/O.
import { RELAY_MODES } from '../contract/relay-apply.js'
/** @import { RelayMode, RelaySlot } from '../contract/relay-apply.js' */

export const SETTINGS_VERSION = 1

/**
 * @typedef {{ version: number,
 *   downloads: { folder: string | null },
 *   network: { downloadKBps: number, uploadKBps: number, relayMode: RelayMode, relay: RelaySlot | null, downloadConcurrency: number },
 *   backup: { folder: string | null, repoId: string | null } }} Settings
 */

/** @returns {Settings} */
export function defaultSettings() {
  return {
    version: SETTINGS_VERSION,
    downloads: { folder: null },
    // downloadConcurrency has no setter and no UI on purpose: it is an operator lever and the
    // rollback path for the shared fetch gate. 0 disables the gate entirely.
    network: { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relay: null, downloadConcurrency: 6 },
    backup: { folder: null, repoId: null },
  }
}

const isPlainObject = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)
const nonEmptyString = (v) => (typeof v === 'string' && v.length > 0 ? v : null)
const countAtLeastZero = (v, fallback) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? Math.floor(v) : fallback)

// Every field is re-derived from the parsed input against the defaults: a hand-edited or truncated
// file yields the default for the field it broke, never a value the worker would refuse.
// `sanitizeRelay` is injected because it decodes the key, which the contract package cannot do.
/** @param {unknown} raw @param {{ sanitizeRelay: (entry: unknown) => RelaySlot | null }} deps @returns {Settings} */
export function coerceSettings(raw, { sanitizeRelay }) {
  const d = defaultSettings()
  const src = isPlainObject(raw) ? raw : {}
  const downloads = isPlainObject(src.downloads) ? src.downloads : {}
  const network = isPlainObject(src.network) ? src.network : {}
  const backup = isPlainObject(src.backup) ? src.backup : {}
  return {
    version: SETTINGS_VERSION,
    downloads: { folder: nonEmptyString(downloads.folder) },
    network: {
      downloadKBps: countAtLeastZero(network.downloadKBps, d.network.downloadKBps),
      uploadKBps: countAtLeastZero(network.uploadKBps, d.network.uploadKBps),
      relayMode: RELAY_MODES.includes(network.relayMode) ? network.relayMode : 'off',
      relay: sanitizeRelay(network.relay),
      downloadConcurrency: countAtLeastZero(network.downloadConcurrency, d.network.downloadConcurrency),
    },
    backup: { folder: nonEmptyString(backup.folder), repoId: nonEmptyString(backup.repoId) },
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
// the device that made the backup).
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
