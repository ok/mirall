// The signing keys a bundle may verify against on this channel, plus the test lever's key, which the
// worker receives only where envOverride honours it.
import b4a from 'b4a'
import { PINNED_SIGNING_KEYS } from '../contract/managed-trust.js'

export function pinnedKeysFor(channel, { testKeyHex = null } = {}) {
  const pinned = PINNED_SIGNING_KEYS[channel] ?? []
  const keys = pinned.map((hex) => b4a.from(hex, 'hex'))
  if (typeof testKeyHex === 'string' && /^[0-9a-f]{64}$/i.test(testKeyHex)) keys.push(b4a.from(testKeyHex, 'hex'))
  return keys
}
