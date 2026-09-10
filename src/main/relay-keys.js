// The relay slot arrives from the renderer, which is not a trust boundary. A key that
// reaches swarm.relayThrough without decoding to exactly 32 bytes produces a silent
// connect failure with no diagnosis, so validation happens here, in main, before
// anything is persisted.
const idEncoding = require('hypercore-id-encoding')

const RELAY_MODES = ['off', 'auto', 'always']
const MAX_LABEL_LENGTH = 64

function decodeRelayKey(id) {
  if (typeof id !== 'string' || id.length === 0) return null
  try {
    const key = idEncoding.decode(id)
    return key.byteLength === 32 ? key : null
  } catch {
    return null
  }
}

function isValidRelayKey(id) {
  return decodeRelayKey(id) !== null
}

function normalizeRelayMode(mode) {
  return RELAY_MODES.includes(mode) ? mode : 'off'
}

function sanitizeLastTest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { at, ok } = value
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof ok !== 'boolean') return null
  return { at, ok }
}

// The single relay slot, as stored. The ticket and its member seed are NOT here — they live
// in relay-ticket.enc under safeStorage (see relay-secret.js), because a member seed is a
// bearer credential and config.json is a plain-text prefs file that ends up in backups.
// `kind` is the only trace of a private relay that reaches disk here, so the UI can pick the
// right badge and the right warning without touching the vault.
function sanitizeRelay(entry) {
  if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null
  const { publicKey, label, kind, enabled, lastTest } = entry
  if (!decodeRelayKey(publicKey)) return null
  return {
    publicKey,
    kind: kind === 'private' ? 'private' : 'open',
    label: typeof label === 'string' ? label.slice(0, MAX_LABEL_LENGTH) : '',
    enabled: enabled !== false,
    lastTest: sanitizeLastTest(lastTest),
  }
}

module.exports = {
  decodeRelayKey,
  isValidRelayKey,
  normalizeRelayMode,
  sanitizeRelay,
  MAX_LABEL_LENGTH,
}
