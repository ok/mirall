import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { initStore, setMasterSecret, LOCAL_BEE_NAMES } from '../../src/shared/core/store.js'
import {
  initAuditLog, record, flushAudit, queryAudit, auditSpaces, auditActors,
  auditStats, getAuditConfig, setAuditConfig, pruneAudit, purgeAudit, exportAudit,
  getPeerSubjectState, setPeerSubjectState,
} from '../../src/shared/audit/audit-log.js'

let seq = 0
function tmpDir (label) {
  const dir = path.join(os.tmpdir(), `audit-${label}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}-${seq++}`)
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

async function boot (t, { identity = true } = {}) {
  const storage = tmpDir('store')
  t.teardown(() => { try { fs.rmSync(storage, { recursive: true, force: true }) } catch {} })
  initStore(storage)
  setMasterSecret(identity ? crypto.randomBytes(32) : null)
  await initAuditLog({ installId: 'install-under-test' })
  await setAuditConfig({ enabled: true, retentionDays: 90, maxEntries: 200000 })
  await purgeAudit()
  return storage
}

function member (kind, spaceId, spaceName, actorName) {
  record(kind, {
    actor: { type: 'peer', key: 'peer-' + actorName, name: actorName },
    space: { id: spaceId, name: spaceName },
    target: { kind: 'member', id: 'peer-' + actorName, name: actorName },
  })
}

test('audit-log is registered as a local bee so it inherits at-rest encryption', (t) => {
  t.ok(LOCAL_BEE_NAMES.includes('audit-log'), 'missing here means createLocalBee throws and the leftover sweep can reclaim the core')
})

test('records land newest-first with monotonic seqs', async (t) => {
  await boot(t)
  member('member.joined', 'sp1', 'Design Team', 'Anna')
  member('member.joined', 'sp1', 'Design Team', 'Ben')
  member('member.left', 'sp1', 'Design Team', 'Clara')
  await flushAudit()

  const { entries } = await queryAudit({})
  t.is(entries.length, 3)
  t.is(entries[0].actor.name, 'Clara', 'newest first')
  t.is(entries[2].actor.name, 'Anna')
  t.alike(entries.map((e) => e.seq), [2, 1, 0], 'seqs are dense and descending')
  t.is(entries[0].device, 'install-under-test')
})

test('a disabled log records nothing but still reads', async (t) => {
  await boot(t)
  await setAuditConfig({ enabled: false })
  member('member.joined', 'sp1', 'Design Team', 'Anna')
  await flushAudit()
  t.is((await queryAudit({})).entries.length, 0)

  await setAuditConfig({ enabled: true })
  member('member.joined', 'sp1', 'Design Team', 'Ben')
  await flushAudit()
  t.is((await queryAudit({})).entries.length, 1, 're-enabling resumes recording')
})

test('space filter uses the index and returns only that space', async (t) => {
  await boot(t)
  member('member.joined', 'sp1', 'Design Team', 'Anna')
  member('member.joined', 'sp2', 'Q3 Launch', 'Ben')
  member('member.joined', 'sp1', 'Design Team', 'Clara')
  await flushAudit()

  const { entries } = await queryAudit({ spaceId: 'sp1' })
  t.is(entries.length, 2)
  t.ok(entries.every((e) => e.space.id === 'sp1'))
})

test('kind, category, actor and free-text filters compose', async (t) => {
  await boot(t)
  member('member.joined', 'sp1', 'Design Team', 'Anna')
  member('member.left', 'sp1', 'Design Team', 'Anna')
  record('file.shared', {
    actor: { type: 'self', key: 'me', name: 'Me' },
    space: { id: 'sp1', name: 'Design Team' },
    target: { kind: 'file', id: 'q3.pdf', name: 'Q3-report.pdf' },
  })
  await flushAudit()

  t.is((await queryAudit({ kinds: ['member.left'] })).entries.length, 1)
  t.is((await queryAudit({ categories: ['files'] })).entries.length, 1)
  t.is((await queryAudit({ actorKey: 'peer-Anna' })).entries.length, 2)
  t.is((await queryAudit({ search: 'q3-report' })).entries.length, 1, 'search hits the file name')
  t.is((await queryAudit({ search: 'Q3-REPORT' })).entries.length, 1, 'search is case-insensitive')
  t.is((await queryAudit({ kinds: ['member.left'], actorKey: 'peer-Anna' })).entries.length, 1, 'filters compose')
  t.is((await queryAudit({ search: 'approved' })).entries.length, 0, 'the kind is not searchable text')
})

test('cursor pagination walks the whole log without repeats or gaps', async (t) => {
  await boot(t)
  for (let i = 0; i < 25; i++) member('member.joined', 'sp1', 'Design Team', 'peer' + i)
  await flushAudit()

  const seen = []
  let cursor = null
  let pages = 0
  do {
    const page = await queryAudit({ cursor, limit: 10 })
    seen.push(...page.entries.map((e) => e.seq))
    cursor = page.nextCursor
    pages++
    t.ok(pages < 10, 'pagination terminates')
  } while (cursor !== null)

  t.is(seen.length, 25, 'every row was returned exactly once')
  t.is(new Set(seen).size, 25, 'no repeats across pages')
  t.alike(seen, [...seen].sort((a, b) => b - a), 'order stays newest-first across pages')
})

test('rows appended mid-pagination do not shift an in-flight cursor', async (t) => {
  await boot(t)
  for (let i = 0; i < 10; i++) member('member.joined', 'sp1', 'Design Team', 'old' + i)
  await flushAudit()

  const first = await queryAudit({ limit: 5 })
  member('member.joined', 'sp1', 'Design Team', 'brandnew')
  await flushAudit()
  const second = await queryAudit({ cursor: first.nextCursor, limit: 5 })

  const overlap = second.entries.filter((e) => first.entries.some((f) => f.seq === e.seq))
  t.is(overlap.length, 0, 'the seq cursor is stable under concurrent appends — an offset would skew')
  t.absent(second.entries.some((e) => e.actor.name === 'brandnew'), 'the new row is not pulled backwards into page 2')
})

test('a filtered page may come back partial while more remains', async (t) => {
  await boot(t)
  member('member.left', 'sp1', 'Design Team', 'Needle')
  for (let i = 0; i < 30; i++) member('member.joined', 'sp1', 'Design Team', 'noise' + i)
  await flushAudit()

  const page = await queryAudit({ kinds: ['member.left'], limit: 10 })
  t.ok(page.entries.length < 10, 'fewer rows than the limit')
  t.is(page.entries.length, 1)
})

test('the space filter still lists a space that no longer exists', async (t) => {
  await boot(t)
  member('space.left', 'gone', 'Old Archive', 'Me')
  member('member.joined', 'sp1', 'Design Team', 'Anna')
  await flushAudit()

  const spaces = await auditSpaces()
  t.ok(spaces.some((s) => s.id === 'gone' && s.name === 'Old Archive'),
    'the log is the source for the filter — a left space keeps its snapshotted name')
  const actors = await auditActors()
  t.ok(actors.some((a) => a.key === 'peer-Anna'))
})

test('retention prunes by age, keeping rows inside the window', async (t) => {
  await boot(t)
  for (let i = 0; i < 5; i++) member('member.joined', 'sp1', 'Design Team', 'p' + i)
  await flushAudit()

  await setAuditConfig({ retentionDays: 1 })
  const future = Date.now() + 3 * 86400000
  await pruneAudit({ now: future })
  t.is((await queryAudit({})).entries.length, 0, 'everything aged out')

  member('member.joined', 'sp1', 'Design Team', 'fresh')
  await flushAudit()
  await pruneAudit({ now: Date.now() })
  t.is((await queryAudit({})).entries.length, 1, 'a fresh row survives a prune at the same instant')
})

test('retention prunes by count when the age window is wide', async (t) => {
  await boot(t)
  await setAuditConfig({ retentionDays: 3650, maxEntries: 10 })
  for (let i = 0; i < 25; i++) member('member.joined', 'sp1', 'Design Team', 'p' + i)
  await flushAudit()

  const { removed } = await pruneAudit({ now: Date.now() })
  t.is(removed, 15)
  const { entries } = await queryAudit({ limit: 100 })
  t.is(entries.length, 10, 'the newest maxEntries rows survive')
  t.is(entries[0].actor.name, 'p24')
})

test('pruning also drops the by-space index entries', async (t) => {
  await boot(t)
  await setAuditConfig({ retentionDays: 3650, maxEntries: 2 })
  for (let i = 0; i < 6; i++) member('member.joined', 'sp1', 'Design Team', 'p' + i)
  await flushAudit()
  await pruneAudit({ now: Date.now() })

  const { entries } = await queryAudit({ spaceId: 'sp1', limit: 100 })
  t.is(entries.length, 2, 'a stale index entry would resurrect a deleted row here')
})

test('purge empties the log and resets nothing else', async (t) => {
  await boot(t)
  for (let i = 0; i < 5; i++) member('member.joined', 'sp1', 'Design Team', 'p' + i)
  await flushAudit()

  const { purged } = await purgeAudit()
  t.is(purged, 5)
  t.is((await queryAudit({})).entries.length, 0)
  t.alike(await auditSpaces(), [], 'the space filter empties with it')
  t.is(getAuditConfig().enabled, true, 'purge is not a disable')
})

test('stats report the true range', async (t) => {
  await boot(t)
  member('member.joined', 'sp1', 'Design Team', 'Anna')
  member('member.joined', 'sp1', 'Design Team', 'Ben')
  await flushAudit()

  const stats = await auditStats()
  t.is(stats.count, 2)
  t.is(stats.oldestSeq, 0)
  t.is(stats.newestSeq, 1)
  t.ok(stats.newestTs >= stats.oldestTs)
})

test('export returns chronological rows and honours a space filter', async (t) => {
  await boot(t)
  member('member.joined', 'sp1', 'Design Team', 'Anna')
  member('member.joined', 'sp2', 'Q3 Launch', 'Ben')
  member('member.joined', 'sp1', 'Design Team', 'Clara')
  await flushAudit()

  const all = await exportAudit({})
  t.is(all.length, 3)
  t.alike(all.map((e) => e.seq), [0, 1, 2], 'export reads oldest-first so the file reads chronologically')
  t.is((await exportAudit({ spaceId: 'sp1' })).length, 2)
})

test('config and the seq allocator are recovered from disk, not from memory', async (t) => {
  await boot(t)
  await setAuditConfig({ retentionDays: 30, maxEntries: 500 })
  for (let i = 0; i < 3; i++) member('member.joined', 'sp1', 'Design Team', 'p' + i)
  await flushAudit()

  // Re-init against the same (still-open) store: a second initStore would take a second
  // RocksDB lock. This still exercises the boot path — config is re-read and nextSeq is
  // recomputed from the highest stored row rather than carried in memory.
  await initAuditLog({ installId: 'install-under-test' })
  t.is(getAuditConfig().retentionDays, 30, 'config is durable')
  t.is(getAuditConfig().maxEntries, 500)

  member('member.joined', 'sp1', 'Design Team', 'after-restart')
  await flushAudit()
  const { entries } = await queryAudit({ limit: 100 })
  t.is(entries[0].seq, 3, 'the allocator resumed past the highest stored row')
  t.is(entries.length, 4, 'nothing was overwritten by a reused seq')
})

test('an unknown kind is dropped without throwing into the caller', async (t) => {
  await boot(t)
  t.execution(() => record('not.a.kind', { space: { id: 'sp1', name: 'x' } }), 'record never throws at the call site')
  await flushAudit()
  t.is((await queryAudit({})).entries.length, 0)
})

test('the rate guard collapses a burst into one suppressed row', async (t) => {
  await boot(t)
  for (let i = 0; i < 400; i++) member('member.joined', 'sp1', 'Design Team', 'p' + i)
  await flushAudit()

  const { entries } = await queryAudit({ limit: 1000 })
  t.ok(entries.length < 400, 'the burst was capped rather than written in full')
  t.ok(entries.length >= 120, 'the window budget was spent before capping')
})

// Rows are stamped with Date.now() inside record(), so building a pathological ts order
// means driving the clock.
async function recordAt (ts, spaceId, actorName) {
  const real = Date.now
  Date.now = () => ts
  try {
    record('member.joined', {
      actor: { type: 'peer', key: 'k-' + actorName, name: actorName },
      space: { id: spaceId, name: 'Design Team' },
      target: { kind: 'member', id: 'k-' + actorName, name: actorName },
    })
    await flushAudit()
  } finally {
    Date.now = real
  }
}

test('REGRESSION: a stale-ts row after fresh rows does not drag the prune watermark over them', async (t) => {
  await boot(t)
  await setAuditConfig({ retentionDays: 1, maxEntries: 200000 })
  const now = Date.now()
  const OLD = now - 10 * 86400000
  const YOUNG = now - 60000

  await recordAt(OLD, 'sp1', 'old-a')      // seq 0
  await recordAt(OLD, 'sp1', 'old-b')      // seq 1
  await recordAt(YOUNG, 'sp1', 'keep-a')   // seq 2 — inside retention
  await recordAt(YOUNG, 'sp1', 'keep-b')   // seq 3 — inside retention
  await recordAt(OLD, 'sp1', 'clock-glitch') // seq 4 — stale ts written AFTER fresh rows
  // Enough young rows to trip AGE_HYSTERESIS and end the scan.
  for (let i = 0; i < 25; i++) await recordAt(YOUNG, 'sp1', 'young-' + i)

  await pruneAudit({ now })
  const names = (await queryAudit({ limit: 100 })).entries.map((e) => e.actor.name)
  t.ok(names.includes('keep-a'), 'an in-retention row before the stale one survives')
  t.ok(names.includes('keep-b'), 'and so does its neighbour')
  t.absent(names.includes('old-a'), 'the genuinely old prefix is still pruned')
  t.absent(names.includes('old-b'), 'both of it')
})

test('purging the log clears the per-peer observed-state mirror', async (t) => {
  await boot(t)
  await setPeerSubjectState('share|peer1|sp1|share1', 'on')
  t.is(await getPeerSubjectState('share|peer1|sp1|share1'), 'on')

  await purgeAudit()
  t.is(await getPeerSubjectState('share|peer1|sp1|share1'), null,
    'delete-all-activity must not leave the record of what we observed')
})

test("an 'off' subject state is dropped rather than stored forever", async (t) => {
  await boot(t)
  await setPeerSubjectState('file|peer1|sp1|a.txt', 'on')
  await setPeerSubjectState('file|peer1|sp1|a.txt', 'off')
  t.is(await getPeerSubjectState('file|peer1|sp1|a.txt'), null,
    'absence reads the same as off, and bounds growth to currently-shared subjects')
})

test('record() reports whether the row was admitted', async (t) => {
  await boot(t)
  t.is(record('member.joined', { actor: { type: 'self' }, space: { id: 'sp1', name: 'S' } }), true)

  await setAuditConfig({ enabled: false })
  t.is(record('member.joined', { actor: { type: 'self' }, space: { id: 'sp1', name: 'S' } }), false,
    'a disabled log admits nothing — callers must not mirror it as recorded')
})
