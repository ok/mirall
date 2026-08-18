// Format check only, for instant feedback while typing. Main re-decodes every key
// before it is persisted (see src/main/relay-keys.js) and is the authority — the
// renderer is not a trust boundary.
const Z_BASE_32 = 'ybndrfg8ejkmcpqxot1uwisza345h769'
const Z_BASE_32_KEY_LENGTH = 52
const HEX_KEY_LENGTH = 64

export function isWellFormedRelayKey(value: string): boolean {
  const key = value.trim()
  if (key.length === HEX_KEY_LENGTH) return /^[0-9a-fA-F]+$/.test(key)
  if (key.length !== Z_BASE_32_KEY_LENGTH) return false
  for (const char of key) {
    if (!Z_BASE_32.includes(char)) return false
  }
  return true
}

export function truncateRelayKey(key: string): string {
  return key.length <= 16 ? key : `${key.slice(0, 8)}…${key.slice(-6)}`
}

export function newRelayId(): string {
  const bytes = new Uint8Array(6)
  crypto.getRandomValues(bytes)
  return `r_${Array.from(bytes, (b) => b.toString(16).padStart(2, '0')).join('')}`
}
