import test from 'brittle'
import { buildRecord, SCHEMA_VERSION } from '../../src/shared/audit/audit-record.js'
import { KINDS } from '../../src/shared/audit/audit-kinds.js'

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
  t.is(buildRecord({ ...base, outcome: 'denied' }).outcome, 'denied')
  t.is(buildRecord({ ...base, outcome: 'weird' }).outcome, 'ok', 'an unknown outcome degrades to ok')
})

test('every kind in the table builds a valid record', (t) => {
  for (const kind of Object.keys(KINDS)) {
    const rec = buildRecord({ ...base, kind })
    t.ok(rec.category, kind + ' has a category')
    t.ok(rec.tier, kind + ' has a tier')
  }
})
