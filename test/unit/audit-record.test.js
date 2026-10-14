import test from 'brittle'
import { buildRecord, searchText, SCHEMA_VERSION, selfActor, peerActor, systemActor, spaceRef, targetRef } from '../../src/shared/audit/audit-record.js'
import { KINDS, OUTCOME, OUTCOMES, TARGET_KIND } from '../../src/shared/contract/audit-kinds.js'
import { NAME_MAX } from '../../src/shared/contract/limits.js'

const base = { seq: 1, ts: 1754236800000, kind: 'space.created' }

test('stamps schema version, category and tier from the kind table', (t) => {
  const rec = buildRecord({ ...base, kind: 'serve.completed' })
  t.is(rec.v, SCHEMA_VERSION)
  t.is(rec.category, KINDS['serve.completed'].category)
  t.is(rec.tier, KINDS['serve.completed'].tier, 'a peer-attributable serve is tier B')
})

// The install id groups a machine's own rows. It is not a key and it is not a device: the word
// `device` is reserved for a real device key, and the bee's by-device/ index means something else.
test('the install id passes through, and an absent one is null rather than empty', (t) => {
  t.is(buildRecord({ ...base, installId: 'install-under-test' }).installId, 'install-under-test')
  t.is(buildRecord({ ...base }).installId, null)
  t.is(buildRecord({ ...base, installId: '' }).installId, null)
  t.absent('device' in buildRecord({ ...base, installId: 'x' }), 'the row no longer carries a device field')
})

test('an unknown kind is refused rather than silently bucketed', (t) => {
  t.exception(() => buildRecord({ ...base, kind: 'space.exploded' }), /unknown kind/)
})

test('a non-integer or negative seq is refused', (t) => {
  t.exception(() => buildRecord({ ...base, seq: 1.5 }), /seq/)
  t.exception(() => buildRecord({ ...base, seq: -1 }), /seq/)
})

test('participant names are snapshotted so a row survives its subject being deleted', (t) => {
  const rec = buildRecord({
    ...base,
    kind: 'membership.approved',
    actor: { type: 'peer', key: 'aa', name: 'Anna Weber' },
    space: { id: 'sp1', name: 'Design Team' },
    target: { kind: 'member', id: 'bb', name: 'Ben Roth' },
  })
  t.is(rec.actor.name, 'Anna Weber')
  t.is(rec.space.name, 'Design Team', 'the space name is in the row, not joined at render time')
  t.is(rec.target.name, 'Ben Roth')
})

test('search blob is lowercased proper nouns only — never the kind', (t) => {
  const rec = buildRecord({
    ...base,
    kind: 'membership.approved',
    actor: { type: 'peer', key: 'aa', name: 'Anna Weber' },
    space: { id: 'sp1', name: 'Design Team' },
    target: { kind: 'member', id: 'bb', name: 'Ben Roth' },
  })
  t.is(rec.search, 'anna weber design team ben roth')
  t.absent(rec.search.includes('approved'), 'the kind stays out so search is locale-neutral')
})

test('REGRESSION (FIX-643: the search blob kept a name in whatever Unicode form it arrived in)', (t) => {
  const decomposed = buildRecord({
    ...base,
    space: { id: 'sp1', name: 'Bu\u0308ro' },
    target: { kind: 'file', id: 'f1', name: 'Bericht_Ma\u0308rz.pdf' },
  })
  t.is(decomposed.search, 'b\u00fcro bericht_m\u00e4rz.pdf')
  const composed = buildRecord({
    ...base,
    space: { id: 'sp1', name: 'B\u00fcro' },
    target: { kind: 'file', id: 'f1', name: 'Bericht_M\u00e4rz.pdf' },
  })
  t.is(composed.search, decomposed.search, 'both spellings store the same text')
})

test('REGRESSION (FIX-643: clamping a decomposed name cut it shorter and could drop its accent)', (t) => {
  const stem = 'x'.repeat(NAME_MAX - 1)
  const rec = buildRecord({ ...base, target: { kind: 'file', id: 'f1', name: stem + 'ä' } })
  t.is(rec.target.name, stem + 'ä', 'the name is composed before it is clamped')
  t.is(rec.search, stem + 'ä')
})

test('search blob tolerates missing participants', (t) => {
  const rec = buildRecord({ ...base, space: { id: 'sp1', name: 'Solo' } })
  t.is(rec.search, 'solo')
  t.is(rec.actor, null)
  t.is(rec.target, null)
})

test('names are clamped so a hostile peer name cannot bloat the log', (t) => {
  const rec = buildRecord({ ...base, actor: { type: 'peer', key: 'aa', name: 'x'.repeat(500) } })
  t.is(rec.actor.name.length, 80)
})

test('a space without an id yields no space ref, so no by-space index entry is written', (t) => {
  const rec = buildRecord({ ...base, space: { name: 'nameless' } })
  t.is(rec.space, null)
})

test('outcome is constrained to the known set', (t) => {
  for (const outcome of OUTCOMES) t.is(buildRecord({ ...base, outcome }).outcome, outcome)
  t.is(buildRecord({ ...base }).outcome, OUTCOME.OK, 'a row without an outcome records a success')
})

// REGRESSION (FIX-AUDIT-OUTCOME: a misspelt outcome was coerced to 'ok', so a security row
// recording a denial claimed an approval — the one thing an audit log may not do.)
test('REGRESSION (FIX-AUDIT-OUTCOME): an unknown outcome is refused, not coerced to ok', (t) => {
  t.exception(() => buildRecord({ ...base, outcome: 'denyed' }), /unknown outcome/)
  t.exception(() => buildRecord({ ...base, outcome: 'DENIED' }), /unknown outcome/)
  t.exception(() => buildRecord({ ...base, outcome: null }), /unknown outcome/)
})

test('every kind in the table builds a valid record', (t) => {
  for (const kind of Object.keys(KINDS)) {
    const rec = buildRecord({ ...base, kind })
    t.ok(rec.category, kind + ' has a category')
    t.ok(rec.tier, kind + ' has a tier')
  }
})

test('an unknown target kind is refused, as an unknown kind and outcome already are', (t) => {
  t.exception(() => buildRecord({ ...base, target: { kind: 'folder', id: 'x', name: 'x' } }), /unknown target kind/)
  t.exception(() => buildRecord({ ...base, target: { id: 'x', name: 'x' } }), /unknown target kind/)
  t.execution(() => buildRecord({ ...base, target: targetRef(TARGET_KIND.SPACE, 'x', 'x') }), 'a declared kind passes')
  t.execution(() => buildRecord({ ...base, target: targetRef(TARGET_KIND.RELAY, 'yry4bqau…e6xk7q', 'Hetzner') }), 'a relay is a declared target')
})

// The builders' output is what the normalizers read, so their field names and null handling are
// the contract between the two halves of this module.
test('the builders produce the shapes buildRecord normalizes', (t) => {
  t.alike(selfActor(), { type: 'self', key: null, name: null })
  t.alike(peerActor('abc', 'Ada'), { type: 'peer', key: 'abc', name: 'Ada' })
  t.alike(systemActor(), { type: 'system', key: null, name: null })
  t.alike(spaceRef('s1', 'Space'), { id: 's1', name: 'Space' })
  t.alike(targetRef(TARGET_KIND.FILE, 'f1', 'a.txt'), { kind: 'file', id: 'f1', name: 'a.txt' })
})

test('a missing id or name becomes null rather than undefined', (t) => {
  t.alike(peerActor(undefined, undefined), { type: 'peer', key: null, name: null })
  t.alike(targetRef(TARGET_KIND.SHARE, undefined, undefined), { kind: 'share', id: null, name: null })
  t.is(spaceRef(null, 'Space'), null, 'a space with no id is no space')
})

// Round-trip: the builders' output is what the record actually carries, so a shape change here
// cannot pass while leaving the row wrong.
test('a record built entirely from the builders round-trips', (t) => {
  const rec = buildRecord({
    ...base,
    actor: peerActor('key1', 'Ada'),
    space: spaceRef('s1', 'Space'),
    target: targetRef(TARGET_KIND.MEMBER, 'key1', 'Ada'),
  })
  t.alike(rec.actor, { type: 'peer', key: 'key1', name: 'Ada' })
  t.alike(rec.space, { id: 's1', name: 'Space' })
  t.alike(rec.target, { kind: 'member', id: 'key1', name: 'Ada' })
  t.is(rec.search, 'ada space ada', 'every builder name reaches the search index')
})

const searchOf = (kind, subject) => searchText(buildRecord({ ...base, kind, subject }))

test("REGRESSION (FIX-642: search missed the names and paths on a row's second line)", (t) => {
  const download = buildRecord({
    ...base,
    kind: 'transfer.completed',
    actor: selfActor('me', 'Me'),
    space: spaceRef('sp1', 'Design Team'),
    target: targetRef(TARGET_KIND.FILE, 'q3.pdf', 'q3.pdf'),
    subject: { folder: 'Quarterly Reports', bytes: 2048 },
  })
  t.is(searchText(download), 'me design team q3.pdf quarterly reports', 'the folder a file came from follows the names')
  t.is(download.search, searchText(download), 'the stored copy is the same text')
  t.ok(searchOf('mirror.created', { mountPath: '/Users/Ada/Mirrors/Plans' }).includes('/users/ada/mirrors/plans'), "a mirror's local path")
  t.ok(searchOf('share.relocated', { from: '/old/Spot', to: '/new/Spot' }).includes('/new/spot'), 'where a folder was moved to')
  t.ok(searchOf('network.peer_relayed', { via: 'own', label: 'Home Box' }).includes('home box'), "your relay's label")
  t.ok(searchOf('network.peer_relayed', { via: 'adopted', provider: 'Cleo' }).includes('cleo'), 'who provides the relay')
  t.ok(searchOf('relay.replaced', { previous: 'abcd1234…ef5678', previousLabel: 'Old Box' }).includes('old box'), 'the replaced relay by label')
  t.ok(searchOf('relay.replaced', { previous: 'abcd1234…ef5678', previousLabel: null }).includes('abcd1234…ef5678'),
    'the replaced relay by masked key when it had no label')
  t.ok(searchOf('relay.replaced', { previous: 'abcd1234…ef5678', previousLabel: 7 }).includes('abcd1234…ef5678'),
    'a label that is not text falls back to the masked key, as the row does')
})

test('search leaves out the subject fields a row does not show', (t) => {
  const moved = searchOf('share.relocated', { from: '/old/Spot', to: '/new/Spot', ownerKey: 'ownerkey' })
  t.absent(moved.includes('/old/spot'), 'the old location is not on the row')
  t.absent(moved.includes('ownerkey'))
  t.absent(searchOf('relay.replaced', { previous: 'abcd1234…ef5678', previousLabel: 'Old Box' }).includes('abcd1234'),
    'the masked key is not shown while the relay had a label')
  t.is(searchOf('network.peer_relayed', { via: 'adopted', label: 'Hidden', provider: 'Cleo' }), 'cleo', 'a label shows only on your own relay')
  t.is(searchOf('network.peer_relayed', { via: 'own', provider: 'Hidden' }), '', 'a provider shows only on an adopted relay')
  t.is(searchOf('transfer.completed', { label: 'Hidden', previous: 'Hidden' }), '', 'relay names show only on relay rows')
  t.is(searchOf('transfer.completed', { folder: 42, mountPath: ['x'] }), '', 'a non-string subject field is no text')
})

test('a long folder name is found whole, and the stored copy is cut at its cap', (t) => {
  const name = (c) => c.repeat(NAME_MAX)
  const folder = 'Annual Planning '.repeat(8) + 'Final'
  const rec = buildRecord({
    ...base,
    kind: 'transfer.completed',
    actor: selfActor('me', name('a')),
    space: spaceRef('sp1', name('s')),
    target: targetRef(TARGET_KIND.FILE, 'f', name('t')),
    subject: { folder, mountPath: '/' + 'p'.repeat(5000) },
  })
  t.ok(searchText(rec).includes(folder.toLowerCase()), 'the search reads the folder as the row shows it')
  t.ok(searchText(rec).endsWith('p'.repeat(5000)), 'and the whole path')
  t.is(rec.search, searchText(rec).slice(0, 300), 'the stored copy is the same text, capped')
})
