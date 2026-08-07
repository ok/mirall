// Relay entries arrive from the renderer, which is not a trust boundary. A key that
// reaches swarm.relayThrough without decoding to exactly 32 bytes produces a silent
// connect failure with no diagnosis, so validation happens here, in main, before
// anything is persisted.
const b4a = require('b4a')
const idEncoding = require('hypercore-id-encoding')

const RELAY_MODES = ['off', 'auto', 'always']
const MAX_RELAYS = 8
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

// Drops malformed entries rather than rejecting the whole array: one bad row from a
// hand-edited config.json must not cost the user every other relay they configured.
// Duplicates collapse to the first occurrence, compared on the DECODED bytes — the same
// relay can be written as z-base-32, either hex case, or a pear:// URL.
function sanitizeRelays(list) {
  if (!Array.isArray(list)) return []
  const seen = new Set()
  const out = []
  for (const entry of list) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue
    const { id, label, publicKey, enabled, lastTest } = entry
    if (typeof id !== 'string' || id.length === 0) continue
    const key = decodeRelayKey(publicKey)
    if (!key) continue
    const fingerprint = b4a.toString(key, 'hex')
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({
      id,
      label: typeof label === 'string' ? label.slice(0, MAX_LABEL_LENGTH) : '',
      publicKey,
      enabled: enabled !== false,
      lastTest: sanitizeLastTest(lastTest),
    })
    if (out.length >= MAX_RELAYS) break
  }
  return out
}

module.exports = { decodeRelayKey, isValidRelayKey, normalizeRelayMode, sanitizeRelays, RELAY_MODES, MAX_RELAYS }
