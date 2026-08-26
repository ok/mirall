import test from 'brittle'
import {
  createPeerPresenceTracker, peerKeyOf, PEER_DWELL_MS, KIND_PEER_LOST, KIND_PEER_BACK,
} from '../../src/shared/audit/peer-episodes.js'

const T0 = 1700000000000
const META = { memberName: 'Anna Keller', spaceName: 'Design Team' }
const D = PEER_DWELL_MS

test('a blip below the floor produces nothing — not even a lone "is back"', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: META })
  t.is(p.step(T0 + 30000).rows.length, 0)
  t.is(p.seen('anna', 'sp1', { now: T0 + 30000 }), null, 'no back row for an absence nobody saw')
  t.is(p.step(T0 + D * 2).rows.length, 0, 'and the absence is gone, not merely quiet')
  t.is(p.size(), 0)
})

test('a real absence writes one lost row, then one back row with the duration', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: META })

  const { rows, waitMs } = p.step(T0 + D)
  t.is(rows.length, 1)
  t.is(rows[0].kind, KIND_PEER_LOST)
  t.is(rows[0].subject.sinceTs, T0)
  t.is(rows[0].meta.memberName, 'Anna Keller', 'the name is snapshotted at loss, not joined later')
  t.is(waitMs, null)

  const back = p.seen('anna', 'sp1', { now: T0 + D + 120000 })
  t.is(back.kind, KIND_PEER_BACK)
  t.is(back.subject.durationMs, D + 120000)
  t.is(back.meta.spaceName, 'Design Team')
})

test('the same absence is not re-ripened on every tick', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: META })
  t.is(p.step(T0 + D).rows.length, 1)
  t.is(p.step(T0 + D + 1000).rows.length, 0)
  t.is(p.step(T0 + D * 5).rows.length, 0)
})

test('two sockets tearing down are one absence, timed from the first', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: META })
  p.lost('anna', 'sp1', { now: T0 + 4000, meta: META })
  const { rows } = p.step(T0 + D)
  t.is(rows.length, 1)
  t.is(rows[0].subject.sinceTs, T0)
})

test('presence is per space: gone in one, present in another', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: META })
  p.lost('anna', 'sp2', { now: T0, meta: { ...META, spaceName: 'Ops' } })
  const { rows } = p.step(T0 + D)
  t.is(rows.length, 2)
  t.alike(rows.map((r) => r.spaceId).sort(), ['sp1', 'sp2'])
  t.is(peerKeyOf('anna', 'sp1'), 'anna|sp1')
})

test('abandon drops an absence without a row — a leave, or our own outage', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: META })
  p.abandon('anna', 'sp1')
  t.is(p.step(T0 + D).rows.length, 0)

  p.lost('bob', 'sp1', { now: T0, meta: META })
  p.lost('cara', 'sp2', { now: T0, meta: META })
  p.abandon()
  t.is(p.step(T0 + D).rows.length, 0, 'our own outage abandons everything')
  t.is(p.size(), 0)
})

test('abandoning one peer everywhere leaves the others alone', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: META })
  p.lost('anna', 'sp2', { now: T0, meta: META })
  p.lost('bob', 'sp1', { now: T0, meta: META })
  p.abandon('anna')
  const { rows } = p.step(T0 + D)
  t.is(rows.length, 1)
  t.is(rows[0].publicKey, 'bob')
})

test('waitMs points at the EARLIEST pending absence', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: META })
  p.lost('bob', 'sp1', { now: T0 + 60000, meta: META })
  t.is(p.step(T0 + 1000).waitMs, D - 1000, 'anna is due first')
})

// audit-log.js exempts audit.suppressed from its own rate guard, so a marker per over-cap absence
// would bound nothing — the cap has to collapse them here, on the transition only.
test('the per-pair cap emits ONE marker, not one per suppressed absence', (t) => {
  const p = createPeerPresenceTracker({ cap: 2 })
  let now = T0
  const cycle = () => {
    p.lost('anna', 'sp1', { now, meta: META })
    const out = p.step(now + D)
    now += D + 1000
    const back = p.seen('anna', 'sp1', { now })
    now += 1000
    return { row: out.rows[0], back }
  }
  t.is(cycle().row.kind, KIND_PEER_LOST)
  t.is(cycle().row.kind, KIND_PEER_LOST)

  const third = cycle()
  t.ok(third.row.suppressed, 'the transition into the capped state is visible')
  t.is(third.row.kind, KIND_PEER_LOST, 'and still names what was suppressed')
  t.is(third.row.cap, 2)

  for (let i = 0; i < 5; i++) {
    const later = cycle()
    t.absent(later.row, 'no further rows while capped — otherwise the cap bounds nothing')
  }
})

// The module header promises a peer_back row only ever closes an absence the reader saw.
test('a cap-suppressed absence never emits a lone "is back online"', (t) => {
  const p = createPeerPresenceTracker({ cap: 1 })
  p.lost('anna', 'sp1', { now: T0, meta: META })
  p.step(T0 + D)
  p.seen('anna', 'sp1', { now: T0 + D + 1 })

  p.lost('anna', 'sp1', { now: T0 + D + 2, meta: META })
  const out = p.step(T0 + D * 2 + 3)
  t.ok(out.rows[0].suppressed, 'this one is over the cap')
  t.is(p.seen('anna', 'sp1', { now: T0 + D * 3 }), null, 'so its return closes nothing')
})

test('a recorded absence that never returns is eventually forgotten', (t) => {
  const p = createPeerPresenceTracker({ staleMs: 1000 })
  p.lost('anna', 'sp1', { now: T0, meta: META })
  t.is(p.step(T0 + D).rows.length, 1)
  t.is(p.size(), 1, 'held open so the return can close it')

  p.step(T0 + D + 2000)
  t.is(p.size(), 0, 'but not forever — an absent peer must not pin an entry')
  t.is(p.seen('anna', 'sp1', { now: T0 + D + 3000 }), null)
})

test('the space name can land after the episode is captured', (t) => {
  const p = createPeerPresenceTracker()
  p.lost('anna', 'sp1', { now: T0, meta: { memberName: 'Anna Keller', spaceName: null } })
  p.annotate('anna', 'sp1', { spaceName: 'Design Team' })
  const { rows } = p.step(T0 + D)
  t.is(rows[0].meta.spaceName, 'Design Team')
  t.is(rows[0].meta.memberName, 'Anna Keller', 'without clobbering what was already known')
})

test('the cap window rolls, so yesterday does not bind today', (t) => {
  const p = createPeerPresenceTracker({ cap: 1, capWindowMs: 10000 })
  p.lost('anna', 'sp1', { now: T0, meta: META })
  t.absent(p.step(T0 + D).rows[0].suppressed)
  p.seen('anna', 'sp1', { now: T0 + D + 1 })

  p.lost('anna', 'sp1', { now: T0 + D + 2, meta: META })
  t.absent(p.step(T0 + D * 2 + 3).rows[0].suppressed, 'the earlier stamp aged out of the window')
})
