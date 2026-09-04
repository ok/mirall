// Pure record -> display-row mapping. Plain JS (with a .d.ts twin) so it unit-tests under
// brittle-node alongside the worker's audit modules.
//
// Every field it reads is snapshotted in the record itself — nothing here joins against live
// state, because a row routinely outlives the space, share or peer it describes.
import { formatDuration } from './connectivity.js'
import { formatSize } from './formatSize.js'

// Which participant a row is "about". `actorLabelKey` distinguishes the three cases the copy
// has to handle: you did it, a named peer did it, or the app did it on its own.
export function actorLabel(entry) {
  const actor = entry.actor
  if (!actor || actor.type === 'system') return { key: 'activityLog.actorSystem', name: null }
  if (actor.type === 'self') return { key: 'activityLog.actorSelf', name: null }
  return { key: null, name: actor.name || null }
}

// What the row's avatar bubble should render: an icon for the app itself, a short "You" label
// for own actions (matching the sentence copy), initials for a peer.
export function avatarKind(entry) {
  if (!entry.actor || entry.actor.type === 'system') return 'system'
  if (entry.actor.type === 'self') return 'self'
  return 'peer'
}

export function actorInitials(entry) {
  const actor = entry.actor
  if (avatarKind(entry) !== 'peer') return null
  const name = (actor.name || shortKey(actor.key) || '').trim()
  if (!name) return '?'
  const parts = name.split(/\s+/).filter(Boolean)
  const letters = parts.length > 1 ? parts[0][0] + parts[parts.length - 1][0] : name.slice(0, 2)
  return letters.toUpperCase()
}

// A badge marks an EXCEPTIONAL row — only a denied or failed outcome qualifies, and it takes the
// red token, which is that token's sanctioned meaning.
//
// Attribution tier deliberately does NOT badge. It did once, when tier C was rare; adding the
// peer-observed kinds made it the common case for every "a peer did something" row, at which
// point a badge on most rows is chrome rather than signal — and the sentence already names a peer
// as the actor, so "REPORTED" restated what the row said. The tier stays on the record for the
// export and the backend console, it just does not decorate the list.
//
// A connectivity row keeps outcome 'ok' — the vocabulary answers "did the described ACT succeed",
// and a network state is not an act, so 'error' would render FAILED and read as a failed transfer.
// Severity is keyed on the kind instead, reusing the SHIPPED connectivity strings so the log, the
// status dot and the toast say the same word. Peer rows get none: a member closing a laptop is
// routine, and by the rule above a badge on a routine row is chrome.
const KIND_BADGE = {
  'network.offline': { labelKey: 'connectivity.offline', tone: 'error' },
  'network.blocked': { labelKey: 'connectivity.offline', tone: 'error' },
  'network.at_risk': { labelKey: 'connectivity.limited', tone: 'passive' },
}

export function rowBadge(entry) {
  if (entry.outcome === 'denied') return { labelKey: 'activityLog.badgeDenied', tone: 'error' }
  if (entry.outcome === 'error') return { labelKey: 'activityLog.badgeFailed', tone: 'error' }
  return KIND_BADGE[entry.kind] || null
}

// `history` is the log's own mark; a device connectivity row gets the app's Network glyph instead,
// so the device family reads as one family. Peer rows are not system rows — they keep the person's
// initials, which is the correct read.
export function systemIcon(entry) {
  return entry.category === 'network' ? 'hub' : 'history'
}

export function isSystemRow(entry) {
  return !entry.actor || entry.actor.type === 'system'
}

// WHY a request was refused, as an i18n key for the meta line. Without it the two refusals a
// reader can actually act on are indistinguishable: a peer asking for content it is not entitled
// to, and a peer asking before its identity was verified (routine on a fresh connection, since the
// content channel is bound before the hello that authenticates it).
//
// Closed set, not a passthrough: an unknown reason — a row written by another version, or a kind
// whose subject.reason means something else entirely — renders nothing rather than a raw key.
const DENIAL_REASONS = new Set(['not-a-member', 'unauthenticated'])

export function denialReasonKey(entry) {
  const reason = entry.outcome === 'denied' ? entry.subject?.reason : null
  return DENIAL_REASONS.has(reason) ? 'activityLog.denialReason.' + reason : null
}

// The i18n key for the sentence. One key per kind keeps the whole sentence translatable as a
// unit — a sentence assembled from fragments cannot be reordered for other languages.
export function sentenceKey(entry) {
  return 'activityLog.kind.' + entry.kind
}

// Interpolation values for that sentence. Names are already snapshots; the fallbacks keep a row
// readable when a peer never published a display name.
export function sentenceValues(entry) {
  return {
    // A peer we refused is usually not a member of any space we share — that is why it was
    // refused — so its name rarely resolves. The short key is still an identity a reader can
    // correlate, and beats a sentence with a hole in it.
    actor: entry.actor?.name || entry.subject?.requester || shortKey(entry.actor?.key) || '',
    space: entry.space?.name || '',
    target: entry.target?.name || '',
  }
}

function shortKey(key) {
  return typeof key === 'string' && key ? key.slice(0, 12) : null
}

// A sentence is ONE translatable string, so interpolating it yields flat text and the entity
// names inside it lose all emphasis — "You deleted the folder share Large Files" reads as prose.
//
// Rather than reach for <Trans> (which would rewrite all ~27 catalogue strings), the sentence is
// interpolated with sentinels and split back apart. The translator keeps full freedom over word
// order because we parse THEIR rendered output; and the sentinel is U+001F (unit separator),
// which cannot occur in a display name, so the split can never be confused by a name that happens
// to contain other punctuation — or by two fields sharing the same value.
export const FIELD_SENTINEL = '\u001F'
export const SENTENCE_FIELDS = ['actor', 'space', 'target']

export function sentinelValues() {
  const out = {}
  for (const field of SENTENCE_FIELDS) out[field] = FIELD_SENTINEL + field + FIELD_SENTINEL
  return out
}

// Returns [{ text }] and [{ field, value }] segments in render order. A field whose value is
// empty degrades to nothing rather than leaving a hole in the sentence.
export function splitSentence(rendered, values) {
  const segments = []
  let buffer = ''
  for (const part of String(rendered).split(FIELD_SENTINEL)) {
    if (SENTENCE_FIELDS.includes(part)) {
      const value = values?.[part] || ''
      if (value) {
        if (buffer) { segments.push({ text: buffer }); buffer = '' }
        segments.push({ field: part, value })
        continue
      }
      continue
    }
    buffer += part
  }
  if (buffer) segments.push({ text: buffer })
  return segments
}

// One byte size means one string everywhere. This used to carry its own decimal-labelled,
// binary-divided ladder, so the Activity Log read ~7.4% below every other screen for the same file.
export function formatBytes(bytes, locale) {
  if (!Number.isFinite(bytes) || bytes < 0) return null
  return formatSize(bytes, locale)
}

export function formatCount(n, locale) {
  return Number.isFinite(n) ? n.toLocaleString(locale) : null
}

// Closed set, like DENIAL_REASONS: a cause written by a newer version renders nothing rather than a
// raw key.
const NETWORK_CAUSES = new Set([
  'os-offline', 'dht-unreachable', 'no-public-address', 'symmetric-nat',
  'udp-degraded', 'peers-unreachable', 'vpn-only-route',
])

// The hold-down means a degraded row lands about a minute after the transition. Below this the gap
// is not worth a clause; above it, naming the real start keeps the row honest without backdating
// `ts`, which the prune path's clock hysteresis relies on.
const START_GAP_MS = 30000

function formatClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })
}

// The muted second line: space name first (it is the row's strongest context), then whatever detail
// the kind carries. Returns STRUCTURED parts — `{ key, values }` for anything that needs
// translating, `{ text }` for a value that is already a proper noun or a formatted number. It used
// to return finished strings, which is how a hard-coded English ' files' shipped to five locales.
export function metaParts(entry, locale) {
  const parts = []
  if (entry.space?.name) parts.push({ text: entry.space.name })
  const subject = entry.subject || {}
  // Which folder a transferred file came from. A proper noun like the space name, so it is pushed
  // as text and needs no catalogue entry; null on a loose file, which renders no segment.
  if (typeof subject.folder === 'string' && subject.folder) parts.push({ text: subject.folder })
  if (Number.isFinite(subject.fileCount)) {
    const files = formatCount(subject.fileCount, locale)
    if (files !== null) {
      parts.push({ key: 'activityLog.metaFiles', values: { count: subject.fileCount, formatted: files } })
    }
  }
  if (Number.isFinite(subject.bytes)) {
    const size = formatBytes(subject.bytes, locale)
    if (size) parts.push({ text: size })
  }
  if (typeof subject.mountPath === 'string' && subject.mountPath) parts.push({ text: subject.mountPath })
  if (typeof subject.to === 'string' && subject.to) parts.push({ text: subject.to })

  if (entry.category === 'network') {
    if (typeof entry.code === 'string' && NETWORK_CAUSES.has(entry.code)) {
      parts.push({ key: 'activityLog.cause.' + entry.code })
    }
    if (Number.isFinite(subject.durationMs)) {
      parts.push({ key: 'activityLog.wasOfflineFor', values: { duration: formatDuration(subject.durationMs) } })
    }
    if (Number.isFinite(subject.sinceTs) && entry.ts - subject.sinceTs >= START_GAP_MS) {
      parts.push({ key: 'activityLog.startedAt', values: { time: formatClock(subject.sinceTs) } })
    }
  }
  return parts
}

// Day buckets for the grouped list. Uses the viewer's current locale day boundaries, not the
// tzOffset stored on the row: the grouping answers "when did this happen for me, now".
export function dayKey(ts, now = Date.now()) {
  const day = 86400000
  const startOfToday = new Date(now)
  startOfToday.setHours(0, 0, 0, 0)
  const start = startOfToday.getTime()
  if (ts >= start) return 'today'
  if (ts >= start - day) return 'yesterday'
  return new Date(ts).toISOString().slice(0, 10)
}

export function groupByDay(entries, now = Date.now()) {
  const groups = []
  let current = null
  for (const entry of entries) {
    const key = dayKey(entry.ts, now)
    if (!current || current.key !== key) {
      current = { key, entries: [] }
      groups.push(current)
    }
    current.entries.push(entry)
  }
  return groups
}

// Which empty state the viewer should show, and the glyph for it. Lives here rather than inline in
// the screen so the branching is unit-testable and does not push an already-over-budget component
// further past the complexity guardrail.
//
// An empty NETWORK log is good news, not a failed search — but only when nothing else narrows the
// view: with a date range applied, "the whole time it has been running" is false the moment an
// outage exists outside the window.
export function emptyStateFor(filters, active) {
  if (!active) return { key: 'empty', icon: 'history' }
  const networkOnly = filters.categories.length === 1
    && filters.categories[0] === 'network'
    && !filters.search.trim()
    && !filters.spaceId
    && !filters.actorKey
    && filters.sinceDays === null
  return networkOnly
    ? { key: 'emptyNetwork', icon: 'hub' }
    : { key: 'emptyFiltered', icon: 'search' }
}
