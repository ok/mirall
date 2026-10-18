// What this build does with each catalog key. A key outside VALIDATE is unknown to this build: a
// bundle that locks one fails as unknown_critical_setting when the key is critical, and the key is
// ignored otherwise.
import catalog from './catalog.v1.json' with { type: 'json' }
import { decodeRelayKey } from '../network/relay-ticket.js'
import { RETENTION_CHOICES } from '../contract/limits.js'
import { parseTemplate } from './path-template.js'

export const CATALOG_VERSIONS = Object.freeze([catalog.catalogVersion])
export const KNOWN_EXTENSIONS = Object.freeze([])
export const DEFERRED = Object.freeze({ 'audit.forwardingEnabled': 'reporting back' })

const template = (platform) => (v) => typeof v === 'string' && typeof parseTemplate(platform, v) === 'object'

const VALIDATE = {
  'network.relayMode': (v) => v === 'off' || v === 'auto' || v === 'always',
  'network.relayKey': (v) => typeof v === 'string' && decodeRelayKey(v) !== null,
  'audit.enabled': (v) => typeof v === 'boolean',
  'audit.retentionDays': (v) => RETENTION_CHOICES.includes(v),
  'backup.folder.windows': template('windows'),
  'backup.folder.macos': template('macos'),
  'backup.folder.linux': template('linux'),
  'backup.required': (v) => typeof v === 'boolean',
}

export const CATALOG_KEYS = Object.freeze(catalog.settings.map((s) => s.key))
export const KNOWN_SETTINGS = new Set(CATALOG_KEYS.filter((key) => key in VALIDATE))

// A gate is locked only toward its restrictive value: an organization can require the Activity Log
// or a backup, never switch one off.
export function acceptValue(key, value) {
  const spec = catalog.settings.find((s) => s.key === key)
  if (!spec || !VALIDATE[key]?.(value)) return false
  return !(spec.gate && value !== spec.gate.restrictive)
}
