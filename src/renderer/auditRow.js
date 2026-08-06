// Pure record -> display-row mapping. Plain JS (with a .d.ts twin) so it unit-tests under
// brittle-node alongside the worker's audit modules.
//
// Every field it reads is snapshotted in the record itself — nothing here joins against live
// state, because a row routinely outlives the space, share or peer it describes.

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
export function rowBadge(entry) {
  if (entry.outcome === 'denied') return { labelKey: 'activityLog.badgeDenied', tone: 'error' }
  if (entry.outcome === 'error') return { labelKey: 'activityLog.badgeFailed', tone: 'error' }
  return null
}

export function isSystemRow(entry) {
  return !entry.actor || entry.actor.type === 'system'
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

const BYTES_UNITS = ['B', 'KB', 'MB', 'GB', 'TB']

export function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes < 0) return null
  let value = bytes
  let unit = 0
  while (value >= 1024 && unit < BYTES_UNITS.length - 1) {
    value /= 1024
    unit++
  }
  const rounded = value >= 100 || unit === 0 ? Math.round(value) : Math.round(value * 10) / 10
  return rounded + ' ' + BYTES_UNITS[unit]
}

export function formatCount(n) {
  return Number.isFinite(n) ? n.toLocaleString() : null
}

// The muted second line: space name first (it is the row's strongest context), then whatever
// detail the kind carries. Returns already-joined display text plus the parts, so a caller can
// re-order without re-deriving.
export function metaParts(entry) {
  const parts = []
  if (entry.space?.name) parts.push(entry.space.name)
  const subject = entry.subject || {}
  if (Number.isFinite(subject.fileCount)) {
    const files = formatCount(subject.fileCount)
    if (files !== null) parts.push(files + ' files')
  }
  if (Number.isFinite(subject.bytes)) {
    const size = formatBytes(subject.bytes)
    if (size) parts.push(size)
  }
  if (typeof subject.mountPath === 'string' && subject.mountPath) parts.push(subject.mountPath)
  if (typeof subject.to === 'string' && subject.to) parts.push(subject.to)
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
