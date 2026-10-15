// The relay slot as stored. A key that reaches swarm.relayThrough without decoding to exactly
// 32 bytes produces a silent connect failure with no diagnosis, so validation happens here, before
// anything is persisted. The ticket and its member seed are NOT here — they live in
// relay-ticket.enc (relay-secret.js in main), because a member seed is a bearer credential and
// settings.json is a plain-text file that ends up in backups. `kind` is the only trace of a
// private relay that reaches disk here, so the UI can pick the right badge and warning without
// touching the vault.
import { RELAY_MODES } from '../contract/relay-apply.js'
import { decodeRelayKey } from './relay-ticket.js'
/** @import { RelaySlot } from '../contract/relay-apply.js' */

/** @internal */
export const MAX_LABEL_LENGTH = 64

/** @internal */
export function isValidRelayKey(id) {
  return decodeRelayKey(id) !== null
}

/** @param {unknown} mode @returns {import('../contract/relay-apply.js').RelayMode} */
export function normalizeRelayMode(mode) {
  return RELAY_MODES.includes(mode) ? mode : 'off'
}

/** @param {unknown} value @returns {{ at: number, ok: boolean } | null} */
export function sanitizeLastTest(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null
  const { at, ok } = value
  if (typeof at !== 'number' || !Number.isFinite(at) || typeof ok !== 'boolean') return null
  return { at, ok }
}

/** @param {unknown} entry @returns {RelaySlot | null} */
export function sanitizeRelay(entry) {
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
