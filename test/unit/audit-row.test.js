import test from 'brittle'
import {
  actorInitials, actorLabel, avatarKind, dayKey, denialReasonKey, formatBytes, formatCount,
  groupByDay, isSystemRow, metaParts, rowBadge, sentenceKey, sentenceValues,
  splitSentence, sentinelValues, systemIcon, emptyStateFor, FIELD_SENTINEL, SENTENCE_FIELDS,
} from '../../src/renderer/auditRow.js'

const row = (over = {}) => ({
  v: 1, seq: 1, ts: Date.now(), tzOffset: 0,
  kind: 'member.joined', category: 'members', tier: 'B',
  outcome: 'ok', code: null, device: 'd',
  actor: { type: 'peer', key: 'aa', name: 'Anna Weber' },
  space: { id: 'sp1', name: 'Design Team' },
  target: { kind: 'member', id: 'aa', name: 'Anna Weber' },
  subject: null, search: '', ...over,
})

test('actor label distinguishes self, peer and system', (t) => {
  t.is(actorLabel(row({ actor: { type: 'self', key: null, name: null } })).key, 'activityLog.actorSelf')
  t.is(actorLabel(row({ actor: { type: 'system', key: null, name: null } })).key, 'activityLog.actorSystem')
  t.is(actorLabel(row()).name, 'Anna Weber')
  t.is(actorLabel(row()).key, null, 'a named peer needs no label key')
})

test('initials fall back gracefully for an unnamed peer', (t) => {
  t.is(actorInitials(row()), 'AW')
  t.is(actorInitials(row({ actor: { type: 'peer', key: 'x', name: 'Cher' } })), 'CH')
  // An unnamed peer is the norm for a REFUSED request — it is usually not a member of any space
  // we share. Deriving from the key gives the reader something correlatable instead of '?'.
  t.is(actorInitials(row({ actor: { type: 'peer', key: 'ab3f9c2d1e', name: null } })), 'AB')
  t.is(actorInitials(row({ actor: { type: 'peer', key: null, name: null } })), '?', 'nothing at all still renders')
  t.is(actorInitials(row({ actor: { type: 'system', key: null, name: null } })), null)
})

test('a refused request names the requester even with no display name', (t) => {
  const denied = row({
    kind: 'security.serve_denied',
    outcome: 'denied',
    actor: { type: 'peer', key: 'ab3f9c2d1e5a7b', name: null },
    target: { kind: 'file', id: 'hash', name: 'budget.xlsx' },
    subject: { reason: 'not-a-member', requester: 'ab3f9c2d1e5a' },
  })
  t.is(sentenceValues(denied).actor, 'ab3f9c2d1e5a', 'the short key stands in for the missing name')
  t.is(sentenceValues(denied).target, 'budget.xlsx', 'and the file is named when we hold the hash')
  t.is(rowBadge(denied).labelKey, 'activityLog.badgeDenied')
})

// Two very different events render the same sentence: a peer that may not have the content, and a
// peer that asked before its identity was verified. The reason is recorded but was never shown,
// so a reader could not tell an intrusion from a stranger asking for a hash we don't hold.
test('REGRESSION (FIX-364: a refusal shows WHY it was refused)', (t) => {
  const denied = (reason) => row({ kind: 'security.serve_denied', outcome: 'denied', subject: { reason, requester: 'ab3f9c2d1e5a' } })
  t.is(denialReasonKey(denied('not-a-member')), 'activityLog.denialReason.not-a-member')
  t.is(denialReasonKey(denied('unauthenticated')), 'activityLog.denialReason.unauthenticated')

  // Only the reasons the copy covers. A row from another version — or any kind that carries an
  // unrelated `reason` — must not render a raw key or an i18n miss.
  t.is(denialReasonKey(denied('not-held')), null, 'a reason with no copy renders nothing')
  t.is(denialReasonKey(denied(null)), null)
  t.is(denialReasonKey(row()), null, 'an ordinary row has no reason to show')
  t.is(denialReasonKey(row({ subject: { reason: 'quota' } })), null)
})

test('REGRESSION (FIX-2): an own action renders as "You", never a bare "?" avatar', (t) => {
  const own = row({ actor: { type: 'self', key: 'me', name: 'Oliver Kohl' } })
  t.is(avatarKind(own), 'self')
  t.is(actorInitials(own), null, 'a self row must not fall through to the peer initials path')

  // The worker fills the local identity in, but a row written before it was known must still
  // read as "You" rather than the unknown-peer placeholder.
  const bare = row({ actor: { type: 'self', key: null, name: null } })
  t.is(avatarKind(bare), 'self')
  t.is(actorInitials(bare), null)
})

test('avatar kind separates self, peer and system', (t) => {
  t.is(avatarKind(row()), 'peer')
  t.is(avatarKind(row({ actor: { type: 'system', key: null, name: null } })), 'system')
  t.is(avatarKind(row({ actor: null })), 'system')
})

test('system rows are recognised so they render an icon, not initials', (t) => {
  t.ok(isSystemRow(row({ actor: { type: 'system', key: null, name: null } })))
  t.ok(isSystemRow(row({ actor: null })))
  t.absent(isSystemRow(row()))
})

test('only an exceptional OUTCOME badges — never the attribution tier', (t) => {
  t.is(rowBadge(row({ tier: 'A' })), null)
  t.is(rowBadge(row({ tier: 'B' })), null)
  t.is(rowBadge(row({ tier: 'C' })), null,
    'peer-observed rows are the common case, so badging them is chrome — and the sentence already names the peer')
  t.is(rowBadge(row({ outcome: 'denied' })).tone, 'error')
  t.is(rowBadge(row({ outcome: 'error' })).labelKey, 'activityLog.badgeFailed')
})

test('a tier-C row with a bad outcome still badges the outcome', (t) => {
  t.is(rowBadge(row({ tier: 'C', outcome: 'denied' })).labelKey, 'activityLog.badgeDenied')
})

test('sentence key and values come only from the row', (t) => {
  t.is(sentenceKey(row()), 'activityLog.kind.member.joined')
  t.alike(sentenceValues(row()), { actor: 'Anna Weber', space: 'Design Team', target: 'Anna Weber' })
  t.alike(sentenceValues(row({ actor: null, space: null, target: null })), { actor: '', space: '', target: '' },
    'a row with nothing resolved still interpolates without printing undefined')
})

test('byte and count formatting', (t) => {
  t.is(formatBytes(0), '0 B')
  t.is(formatBytes(1024), '1 KB')
  t.is(formatBytes(1536), '1.5 KB')
  t.is(formatBytes(13314398617), '12.4 GB')
  t.is(formatBytes(-1), null)
  t.is(formatCount(5180), (5180).toLocaleString())
})

test('meta line leads with the space and folds in the aggregate totals', (t) => {
  const parts = metaParts(row({
    kind: 'share.mounted',
    subject: { fileCount: 5180, bytes: 13314398617 },
  }))
  t.is(parts[0].text, 'Design Team', 'the space is the strongest context, so it comes first')
  t.ok(parts.some((p) => p.key === 'activityLog.metaFiles'), 'the aggregate file count is shown as one figure')
  t.ok(parts.some((p) => p.text && p.text.includes('GB')))
})

// metaParts used to push `formatCount(n) + ' files'`, so a German reader saw "1.284 files".
test("REGRESSION (FIX-META-I18N: the meta line's file count is translatable)", (t) => {
  const parts = metaParts(row({ kind: 'share.mounted', subject: { fileCount: 1284 } }))
  const files = parts.find((p) => p.key === 'activityLog.metaFiles')
  t.ok(files, 'the count is a key, not a finished English string')
  t.is(files.values.count, 1284, 'count drives the plural')
  t.is(files.values.formatted, (1284).toLocaleString(), 'and the formatted number is interpolated')
  for (const part of parts) t.ok(part.key || typeof part.text === 'string', 'every part is resolvable')
})

test('meta line omits absent detail rather than printing empties', (t) => {
  t.alike(metaParts(row({ space: null, subject: null })), [])
  t.alike(metaParts(row({ subject: { bytes: null, fileCount: null } })), [{ text: 'Design Team' }])
})

test('day bucketing keys today, yesterday and older dates', (t) => {
  const noon = new Date('2026-08-04T12:00:00').getTime()
  t.is(dayKey(noon, noon), 'today')
  t.is(dayKey(noon - 86400000, noon), 'yesterday')
  t.is(dayKey(new Date('2026-07-01T12:00:00').getTime(), noon), '2026-07-01')
})

test('grouping preserves order and does not merge non-adjacent days', (t) => {
  const noon = new Date('2026-08-04T12:00:00').getTime()
  const entries = [
    row({ seq: 3, ts: noon }),
    row({ seq: 2, ts: noon - 86400000 }),
    row({ seq: 1, ts: noon - 86400000 }),
  ]
  const groups = groupByDay(entries, noon)
  t.is(groups.length, 2)
  t.is(groups[0].key, 'today')
  t.is(groups[1].entries.length, 2)
  t.alike(groups.flatMap((g) => g.entries.map((e) => e.seq)), [3, 2, 1], 'row order is untouched')
})

test('a sentence splits into prose and emphasised entity segments', (t) => {
  const rendered = FIELD_SENTINEL + 'actor' + FIELD_SENTINEL + ' deleted the folder ' + FIELD_SENTINEL + 'target' + FIELD_SENTINEL
  t.alike(splitSentence(rendered, { actor: 'Chris', space: '', target: 'Large Files' }), [
    { field: 'actor', value: 'Chris' },
    { text: ' deleted the folder ' },
    { field: 'target', value: 'Large Files' },
  ])
})

test('sentinels survive a translator reordering the sentence', (t) => {
  // German puts the object before the participle; the split follows THEIR order, not ours.
  const rendered = 'Du hast ' + FIELD_SENTINEL + 'target' + FIELD_SENTINEL + ' geteilt'
  t.alike(splitSentence(rendered, { actor: '', space: '', target: 'Q3.pdf' }), [
    { text: 'Du hast ' },
    { field: 'target', value: 'Q3.pdf' },
    { text: ' geteilt' },
  ])
})

test('an empty value collapses rather than leaving a hole', (t) => {
  const rendered = FIELD_SENTINEL + 'actor' + FIELD_SENTINEL + ' left the space'
  t.alike(splitSentence(rendered, { actor: '', space: '', target: '' }), [{ text: ' left the space' }])
})

test('two fields sharing one value stay distinct segments', (t) => {
  // membership rows routinely carry the same name as both actor and target.
  const rendered = FIELD_SENTINEL + 'actor' + FIELD_SENTINEL + ' approved ' + FIELD_SENTINEL + 'target' + FIELD_SENTINEL
  const out = splitSentence(rendered, { actor: 'Bob', space: '', target: 'Bob' })
  t.is(out.length, 3, 'a naive substring split would have collapsed these')
  t.is(out[0].field, 'actor')
  t.is(out[2].field, 'target')
})

test('a name containing the field word is not mistaken for a placeholder', (t) => {
  const rendered = 'You shared ' + FIELD_SENTINEL + 'target' + FIELD_SENTINEL
  t.alike(splitSentence(rendered, { actor: '', space: '', target: 'actor notes.txt' }), [
    { text: 'You shared ' },
    { field: 'target', value: 'actor notes.txt' },
  ])
})

test('sentinelValues wraps every field the sentences can use', (t) => {
  const v = sentinelValues()
  for (const field of SENTENCE_FIELDS) {
    t.is(v[field], FIELD_SENTINEL + field + FIELD_SENTINEL, field + ' is wrapped')
  }
})

const netRow = (over = {}) => row({
  kind: 'network.blocked',
  category: 'network',
  tier: 'A',
  actor: { type: 'system', key: null, name: null },
  space: null,
  target: null,
  code: 'peers-unreachable',
  subject: { sinceTs: Date.now() - 90000 },
  ...over,
})

// outcome:'error' would render FAILED, which on a network row reads as a failed transfer.
test('a connectivity row is badged by KIND, because its outcome is not a failed action', (t) => {
  t.is(rowBadge(netRow({ kind: 'network.offline' })).labelKey, 'connectivity.offline')
  t.is(rowBadge(netRow({ kind: 'network.blocked' })).tone, 'error')
  t.is(rowBadge(netRow({ kind: 'network.at_risk' })).labelKey, 'connectivity.limited')
  t.is(rowBadge(netRow({ kind: 'network.at_risk' })).tone, 'passive', 'at-risk is not the red token')
  t.is(rowBadge(netRow({ kind: 'network.restored' })), null, 'recovery is not exceptional')
  t.is(rowBadge(netRow({ kind: 'network.peer_lost' })), null, 'a member closing a laptop is routine')
})

test('the device family gets the Network glyph; a peer row keeps the person', (t) => {
  t.is(systemIcon(netRow()), 'hub')
  t.is(systemIcon(row()), 'history', 'ordinary system rows are unchanged')
  t.is(avatarKind(netRow()), 'system')
  t.is(
    avatarKind(netRow({ kind: 'network.peer_lost', actor: { type: 'peer', key: 'aa', name: 'Anna Keller' } })),
    'peer',
    'the row is about a person, so it shows one',
  )
})

test('a connectivity row names its cause, its start and its duration', (t) => {
  const ts = Date.now()
  const parts = metaParts(netRow({ ts, subject: { sinceTs: ts - 90000 } }))
  t.ok(parts.some((p) => p.key === 'activityLog.cause.peers-unreachable'))
  t.ok(parts.some((p) => p.key === 'activityLog.startedAt'), 'the hold-down gap is named, not hidden')

  // Production shape: the hold-down puts `ts` ~60s after the recovery, so a `sinceTs` here would
  // always trip the start clause and date the outage to the moment it was fixed.
  const restored = metaParts(netRow({
    kind: 'network.restored',
    code: 'os-offline',
    ts,
    subject: { durationMs: 732000, recoveredTs: ts - 60000, fromKind: 'network.offline' },
  }))
  t.ok(restored.some((p) => p.key === 'activityLog.wasOfflineFor'))
  t.absent(
    restored.some((p) => p.key === 'activityLog.startedAt'),
    'the duration tells the story; a "started" time here would name the recovery',
  )
})

test('an unknown cause and an unknown duration degrade to nothing', (t) => {
  const parts = metaParts(netRow({ code: 'quantum-tunnel', subject: { durationMs: null, sinceTs: null } }))
  t.absent(
    parts.some((p) => p.key && p.key.startsWith('activityLog.cause.')),
    'a cause from a newer version renders nothing, not a raw key',
  )
  t.absent(parts.some((p) => p.key === 'activityLog.wasOfflineFor'), 'a null duration is omitted, not invented')
})

test('a peer connectivity row still leads with its space', (t) => {
  const parts = metaParts(netRow({
    kind: 'network.peer_back',
    code: null,
    space: { id: 'sp1', name: 'Design Team' },
    subject: { durationMs: 2460000 },
  }))
  t.is(parts[0].text, 'Design Team')
  t.ok(parts.some((p) => p.key === 'activityLog.wasOfflineFor'))
})

const filters = (over = {}) => ({
  spaceId: null, categories: [], actorKey: null, search: '', sinceDays: null, ...over,
})

test('an empty NETWORK log reads as good news, not as a failed search', (t) => {
  t.alike(emptyStateFor(filters(), false), { key: 'empty', icon: 'history' }, 'nothing recorded yet')
  t.alike(emptyStateFor(filters({ search: 'anna' }), true), { key: 'emptyFiltered', icon: 'search' })
  t.alike(emptyStateFor(filters({ categories: ['network'] }), true), { key: 'emptyNetwork', icon: 'hub' })
})

// "Able to reach the network the whole time it has been running" is false the moment an outage
// exists outside the window, so any other filter must disqualify the reassuring copy.
test('the reassuring copy needs every other filter clear', (t) => {
  for (const narrowing of [{ sinceDays: 7 }, { spaceId: 'sp1' }, { actorKey: 'aa' }, { search: 'x' }]) {
    const state = emptyStateFor(filters({ categories: ['network'], ...narrowing }), true)
    t.is(state.key, 'emptyFiltered', JSON.stringify(narrowing) + ' must not claim a clean history')
  }
  t.is(emptyStateFor(filters({ categories: ['network', 'files'] }), true).key, 'emptyFiltered',
    'and a second category is not a network-only view')
})
