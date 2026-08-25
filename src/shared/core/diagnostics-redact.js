// Redaction for the diagnostics bundle. Pure and dependency-free so it loads under bare
// (worker), node (main + unit tests) and the renderer alike — the contract has to be
// enforced identically on both halves of the bundle.
//
// Deliberately aggressive and lossy: a log line that becomes unreadable is a far cheaper
// failure than one that ships a user's home directory to a support inbox.

const KEY_RE = /\b[0-9a-f]{32,}\b|\b[a-z2-7]{50,}\b/gi
const IPV4_RE = /\b(?:\d{1,3}\.){3}\d{1,3}\b/g
const IPV6_RE = /\b[0-9a-f:]*::[0-9a-f:]*[0-9a-f]\b|\b(?:[0-9a-f]{1,4}:){7}[0-9a-f]{1,4}\b/gi
const PATH_RE = /(?:\/[^\s/\\:]+){2,}|[A-Za-z]:\\(?:[^\s/\\]+\\?){1,}/gu

export function shortId(value, keep = 4) {
  if (typeof value !== 'string' || !value) return null
  return value.length <= keep ? '…' : value.slice(0, keep) + '…'
}

// Order matters: paths first, because a Windows path can contain runs that match nothing
// else; keys before IPv6, because a long hex run reads as a v6 group.
export function redactLine(line) {
  if (typeof line !== 'string') return ''
  return line
    .replace(PATH_RE, '‹path›')
    .replace(KEY_RE, (match) => match.slice(0, 4) + '…')
    .replace(IPV4_RE, '‹ip›')
    .replace(IPV6_RE, '‹ip6›')
}

export function makeAliaser(prefix) {
  const seen = new Map()
  return (value) => {
    if (!value) return null
    if (!seen.has(value)) seen.set(value, `${prefix}${seen.size}`)
    return seen.get(value)
  }
}
