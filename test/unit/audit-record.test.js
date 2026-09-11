import test from 'brittle'
import { buildRecord, SCHEMA_VERSION, selfActor, peerActor, systemActor, spaceRef, targetRef } from '../../src/shared/audit/audit-record.js'
import { KINDS, OUTCOME, OUTCOMES, TARGET_KIND } from '../../src/shared/contract/audit-kinds.js'

const base = { seq: 1, ts: 1754236800000, kind: 'space.created' }

test('stamps schema version, category and tier from the kind table', (t) => {
  const rec = buildRecord({ ...base, kind: 'serve.completed' })
  t.is(rec.v, SCHEMA_VERSION)
  t.is(rec.category, KINDS['serve.completed'].category)
  t.is(rec.tier, KINDS['serve.completed'].tier, 'a peer-attributable serve is tier B')
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
})

// The builders are the point of the module: a row's participant shapes were hand-written at 52
// sites and drifted five ways. normalizeActor and normalizeTarget read exactly these fields.
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
