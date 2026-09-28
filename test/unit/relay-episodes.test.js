import test from 'brittle'
import {
  createRelayEpisodeTracker, KIND_PEER_RELAYED, KIND_PEER_DIRECT,
} from '../../src/shared/audit/relay-episodes.js'

const T0 = 1700000000000
const D = 10000
const PERSON = 'ab'.repeat(32)
const OTHER = 'cd'.repeat(32)

const info = (over = {}) => ({
  noiseKey: 'ef'.repeat(32), plane: 'control', personKey: PERSON, displayName: 'Lena',
  via: 'adopted', relayKey: 'relay-key', relayLabel: null, since: T0, ...over,
})
const reads = (reach) => () => reach

test('a socket held for the dwell opens a stretch with one relayed row', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  const snapshot = info()
  const row = r.relayed(snapshot, T0 + D)
  t.is(row.kind, KIND_PEER_RELAYED)
  t.is(row.info, snapshot, 'the row carries the snapshot taken when the dwell fired')
  t.is(r.size(), 1)
})

test('more held sockets of the same person write nothing', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info(), T0)
  t.is(r.relayed(info({ plane: 'content' }), T0 + 1), null, 'the other plane')
  t.is(r.relayed(info({ relayKey: 'other-relay' }), T0 + 2), null, 'another relay')
  t.is(r.size(), 1)
})

test('a stretch that ends direct writes one direct row with how long it was relayed', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info({ since: T0 }), T0 + D)
  r.left(PERSON, reads('direct'), T0 + 60000)
  const early = r.step(T0 + 60000 + D - 1, reads('direct'))
  t.is(early.rows.length, 0, 'not before the closing dwell')
  t.is(early.waitMs, 1)
  const { rows, waitMs } = r.step(T0 + 60000 + D, reads('direct'))
  t.is(rows.length, 1)
  t.is(rows[0].kind, KIND_PEER_DIRECT)
  t.is(rows[0].info.personKey, PERSON)
  t.is(rows[0].subject.relayedMs, 60000, 'from pairing to the moment it left the relay')
  t.is(waitMs, null)
  t.is(r.size(), 0)
})

test('the path is judged when the dwell ends, never on the edge itself', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: 0 })
  r.relayed(info(), T0)
  r.left(PERSON, reads('direct'), T0 + 1000)
  t.is(r.waitMs(T0 + 1000), 0, 'even a zero dwell only schedules the read')
  t.alike(r.step(T0 + 1000, reads(null)).rows, [], 'and by then the closed socket is gone')
})

test('a disconnect writes nothing, and a direct return closes the stretch', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info({ since: T0 }), T0)
  r.left(PERSON, reads('direct'), T0 + 5000)
  t.alike(r.step(T0 + 5000 + D, reads(null)), { rows: [], waitMs: null }, 'away: nothing, and no polling')
  t.is(r.size(), 1, 'the stretch waits for the person')
  r.returned(PERSON, T0 + 40000)
  t.alike(r.step(T0 + 40000 + D - 1, reads('direct')).rows, [], 'the return holds for a dwell first')
  const { rows } = r.step(T0 + 40000 + D, reads('direct'))
  t.is(rows.length, 1)
  t.is(rows[0].kind, KIND_PEER_DIRECT)
  t.is(rows[0].subject.relayedMs, 5000, 'the relayed time ends when they left the relay, not on return')
})

test('a return through a relay continues the stretch', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info(), T0)
  r.left(PERSON, reads('direct'), T0 + 1000)
  r.step(T0 + 1000 + D, reads(null))
  r.returned(PERSON, T0 + 20000)
  t.alike(r.step(T0 + 20000 + D, reads('relayed')).rows, [])
  t.is(r.relayed(info(), T0 + 20000 + D), null, 'the re-dialled relay joins the open stretch')
  t.is(r.size(), 1)
})

test('a return means nothing for a stretch the person never left', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info(), T0)
  r.returned(PERSON, T0 + 1000)
  t.is(r.waitMs(T0 + 1000), null)
})

test('still relayed at the check keeps the stretch open without polling', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info({ since: T0 }), T0)
  r.left(PERSON, reads('relayed'), T0 + 5000)
  t.alike(r.step(T0 + 5000 + D, reads('relayed')), { rows: [], waitMs: null }, 'another socket still carries them')
  r.left(PERSON, reads('direct'), T0 + 90000)
  const { rows } = r.step(T0 + 90000 + D, reads('direct'))
  t.is(rows[0].subject.relayedMs, 90000, 'the stretch ran until its last relayed socket left')
})

test('a held socket rejoining during the closing dwell cancels the close', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info(), T0)
  r.left(PERSON, reads('direct'), T0 + 1000)
  t.is(r.relayed(info(), T0 + 2000), null)
  t.alike(r.step(T0 + 1000 + D, reads('direct')), { rows: [], waitMs: null })
  t.is(r.size(), 1)
})

test('an edge that cannot name its person re-reads every open stretch', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info(), T0)
  r.relayed(info({ personKey: OTHER }), T0)
  r.left(null, (personKey) => (personKey === PERSON ? 'direct' : 'relayed'), T0 + 1000)
  const { rows } = r.step(T0 + 1000 + D, (personKey) => (personKey === PERSON ? 'direct' : 'relayed'))
  t.alike(rows.map((row) => row.info.personKey), [PERSON])
  t.is(r.size(), 1)
})

test('relayed, direct, relayed again is three rows', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  const kinds = [r.relayed(info(), T0).kind]
  r.left(PERSON, reads('direct'), T0 + 1000)
  kinds.push(...r.step(T0 + 1000 + D, reads('direct')).rows.map((row) => row.kind))
  kinds.push(r.relayed(info(), T0 + 5 * D).kind)
  t.alike(kinds, [KIND_PEER_RELAYED, KIND_PEER_DIRECT, KIND_PEER_RELAYED])
})

test('past the cap one marker naming the person, then silence, then recording resumes', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D, cap: 3, capWindowMs: 1000000 })
  for (let i = 0; i < 3; i++) {
    t.is(r.relayed(info(), T0 + i).kind, KIND_PEER_RELAYED)
    r.left(PERSON, reads('direct'), T0 + i)
    r.step(T0 + i + D, reads('direct'))
  }
  const marker = r.relayed(info(), T0 + D + 10)
  t.ok(marker.suppressed)
  t.is(marker.info.personKey, PERSON)
  t.alike([marker.kind, marker.cap, marker.windowMs], [KIND_PEER_RELAYED, 3, 1000000])
  t.is(r.relayed(info(), T0 + D + 11), null, 'one marker per transition into the cap')
  t.is(r.relayed(info({ personKey: OTHER }), T0 + D + 12).kind, KIND_PEER_RELAYED, 'the cap is per person')
  t.is(r.relayed(info(), T0 + 1000000 + 5).kind, KIND_PEER_RELAYED, 'the window slid past')
})

test('a refused row opens nothing and costs nothing against the cap', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D, cap: 1, capWindowMs: 1000000 })
  for (let i = 0; i < 5; i++) {
    t.is(r.relayed(info(), T0 + i).kind, KIND_PEER_RELAYED)
    r.refused(PERSON)
  }
  t.is(r.size(), 0)
  r.left(PERSON, reads('direct'), T0 + 10)
  t.is(r.waitMs(T0 + 10), null, 'no lone direct row can follow')
})

test('a refused marker is offered again on the next over-cap stretch', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D, cap: 1, capWindowMs: 1000000 })
  r.relayed(info(), T0)
  r.left(PERSON, reads('direct'), T0)
  r.step(T0 + D, reads('direct'))
  t.ok(r.relayed(info(), T0 + D + 1).suppressed)
  r.refused(PERSON)
  t.ok(r.relayed(info(), T0 + D + 2).suppressed)
})

test('a stretch whose person never returns is forgotten after a week', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D, staleMs: 100000 })
  r.relayed(info(), T0)
  r.left(PERSON, reads(null), T0)
  r.step(T0 + D, reads(null))
  r.step(T0 + 100001, reads(null))
  t.is(r.size(), 0)
})

test('the earliest check sets the wait, and reset empties everything', (t) => {
  const r = createRelayEpisodeTracker({ dwellMs: D })
  r.relayed(info(), T0)
  r.relayed(info({ personKey: OTHER }), T0)
  r.left(OTHER, reads('direct'), T0 + 3000)
  r.left(PERSON, reads('direct'), T0 + 1000)
  t.is(r.step(T0 + 2000, reads('direct')).waitMs, D - 1000)
  r.left('nobody', reads(null), T0 + 2000)
  t.is(r.size(), 2, 'an edge for a person with no stretch changes nothing')
  r.reset()
  t.is(r.size(), 0)
  t.alike(r.step(T0 + 5 * D, reads('direct')), { rows: [], waitMs: null })
})
