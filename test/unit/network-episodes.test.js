import test from 'brittle'
import {
  createEpisodeTracker, kindFor, evidenceFor, EPISODE_DWELL_MS,
  KIND_OFFLINE, KIND_BLOCKED, KIND_AT_RISK, KIND_RESTORED, NO_EPISODE, NO_OPINION,
} from '../../src/shared/audit/network-episodes.js'

const T0 = 1700000000000
const SESSION = 'run-1'
const DWELL = EPISODE_DWELL_MS

// A driver so a test reads as a timeline rather than a pile of step() calls. `admit:false`
// simulates record() refusing the row (log disabled / rate-limited).
function driver ({ dwellMs = DWELL, persisted = null, session = SESSION } = {}) {
  const tracker = createEpisodeTracker({ dwellMs })
  let state = persisted
  const rows = []
  return {
    rows,
    get state () { return state },
    at (offset, verdict, cause = null, { since = null, admit = true } = {}) {
      const now = T0 + offset
      const out = tracker.step({ verdict, cause, since: since ?? now, now, session, persisted: state })
      if (out.row) {
        rows.push({ ...out.row, at: now })
        if (admit) state = out.next
      }
      return out
    },
  }
}

test('kindFor collapses causes into kinds, and splits only os-offline out', (t) => {
  t.is(kindFor('unknown', null), NO_OPINION, 'unknown is not a state')
  t.is(kindFor('healthy', null), NO_EPISODE)
  t.is(kindFor('at-risk', 'symmetric-nat'), KIND_AT_RISK)
  t.is(kindFor('blocked', 'os-offline'), KIND_OFFLINE)
  t.is(kindFor('blocked', 'vpn-only-route'), KIND_BLOCKED, 'a VPN keeping the only route is not "you are offline"')
  t.is(kindFor('blocked', 'dht-unreachable'), KIND_BLOCKED)
  t.is(kindFor('blocked', 'peers-unreachable'), KIND_BLOCKED)
})

test('a degradation is recorded once, after the hold-down', (t) => {
  const d = driver()
  t.is(d.at(0, 'blocked', 'peers-unreachable').row, null, 'nothing at the transition itself')
  t.is(d.at(DWELL - 1, 'blocked', 'peers-unreachable').row, null, 'nothing one ms early')

  const out = d.at(DWELL, 'blocked', 'peers-unreachable')
  t.is(out.row.kind, KIND_BLOCKED)
  t.is(out.row.code, 'peers-unreachable')
  t.is(out.row.subject.sinceTs, T0, 'the row names the REAL start, not the record time')
  t.is(out.next.kind, KIND_BLOCKED, 'and the standing state advances')

  t.is(d.at(DWELL + 60000, 'blocked', 'peers-unreachable').row, null, 'never again while it holds')
  t.is(d.rows.length, 1)
})

test('a flap inside the hold-down writes nothing at all — in either direction', (t) => {
  const d = driver()
  d.at(0, 'blocked', 'os-offline')
  d.at(5000, 'healthy')
  d.at(60000, 'healthy')
  t.is(d.rows.length, 0, 'no offline row and no restored row')
  t.is(d.state, null, 'and nothing was persisted')
})

test('waitMs tells the caller when to look again — the emit path may never fire again', (t) => {
  const d = driver()
  t.is(d.at(0, 'blocked', 'dht-unreachable').waitMs, DWELL)
  t.is(d.at(20000, 'blocked', 'dht-unreachable').waitMs, DWELL - 20000)
  t.is(d.at(DWELL, 'blocked', 'dht-unreachable').waitMs, null, 'the row settled it')
})

test('unknown holds everything: a sleeping laptop is not an outage', (t) => {
  const d = driver()
  d.at(0, 'healthy')
  d.at(1000, 'unknown')
  d.at(8 * 3600000, 'unknown')
  d.at(8 * 3600000 + 1000, 'healthy')
  t.is(d.rows.length, 0)
})

test('unknown does not reset a hold-down it passes through', (t) => {
  const d = driver()
  d.at(0, 'blocked', 'dht-unreachable')
  d.at(30000, 'unknown')
  const out = d.at(DWELL, 'blocked', 'dht-unreachable')
  t.ok(out.row, 'the wait kept running — the outage did not restart')
})

test('a cause refined inside the same kind writes no second row', (t) => {
  const d = driver()
  d.at(0, 'blocked', 'dht-unreachable')
  d.at(DWELL, 'blocked', 'dht-unreachable')
  d.at(DWELL + 1000, 'blocked', 'no-public-address')
  d.at(DWELL * 3, 'blocked', 'no-public-address')
  t.is(d.rows.length, 1, 'still one blocked episode')
})

test('os-offline and a blocked network are different kinds and both get a row', (t) => {
  const d = driver()
  d.at(0, 'blocked', 'os-offline')
  d.at(DWELL, 'blocked', 'os-offline')
  d.at(DWELL + 1000, 'blocked', 'vpn-only-route')
  d.at(DWELL * 3, 'blocked', 'vpn-only-route')
  t.alike(d.rows.map((r) => r.kind), [KIND_OFFLINE, KIND_BLOCKED])
})

test('at-risk escalating to blocked writes the escalation', (t) => {
  const d = driver()
  d.at(0, 'at-risk', 'symmetric-nat')
  d.at(DWELL, 'at-risk', 'symmetric-nat')
  d.at(DWELL + 1000, 'blocked', 'peers-unreachable')
  d.at(DWELL * 3, 'blocked', 'peers-unreachable')
  t.alike(d.rows.map((r) => r.kind), [KIND_AT_RISK, KIND_BLOCKED])
})

test('restored carries the duration of the episode it closes', (t) => {
  const d = driver()
  d.at(0, 'blocked', 'os-offline')
  d.at(DWELL, 'blocked', 'os-offline')
  d.at(600000, 'healthy', null, { since: T0 + 600000 })
  const out = d.at(600000 + DWELL, 'healthy', null, { since: T0 + 600000 })

  t.is(out.row.kind, KIND_RESTORED)
  t.is(out.row.code, 'os-offline', 'the row names what it recovered FROM')
  t.is(out.row.subject.fromKind, KIND_OFFLINE)
  t.is(out.row.subject.durationMs, 600000, 'ten minutes offline')
  t.is(out.row.subject.sinceTs, undefined, 'a recovery time must not ride the field meaning "started"')
  t.is(out.row.subject.recoveredTs, T0 + 600000)
  t.is(out.next, null, 'and the standing state is cleared')
  t.is(d.state, null)
})

test('an outage spanning a restart has NO duration rather than an invented one', (t) => {
  const d = driver({ persisted: { kind: KIND_BLOCKED, cause: 'peers-unreachable', since: T0, session: 'run-0' } })
  d.at(3600000, 'healthy', null, { since: T0 + 3600000 })
  const out = d.at(3600000 + DWELL, 'healthy', null, { since: T0 + 3600000 })

  t.is(out.row.kind, KIND_RESTORED)
  t.is(out.row.subject.durationMs, null, 'the app was closed for an unknown part of it')
  t.is(out.row.subject.fromKind, KIND_BLOCKED, 'but what it recovered from is still known')
})

test('relaunching on the same bad network is silent', (t) => {
  const first = driver()
  first.at(0, 'at-risk', 'symmetric-nat')
  first.at(DWELL, 'at-risk', 'symmetric-nat')
  t.is(first.rows.length, 1)

  const second = driver({ persisted: first.state })
  second.at(0, 'at-risk', 'symmetric-nat')
  second.at(DWELL * 5, 'at-risk', 'symmetric-nat')
  t.is(second.rows.length, 0, 'the first launch on this network already said so')
})

test('a refused write does not advance the standing state', (t) => {
  const d = driver()
  d.at(0, 'blocked', 'os-offline')
  d.at(DWELL, 'blocked', 'os-offline', { admit: false })
  t.is(d.state, null, 'nothing persisted')

  d.at(DWELL + 1000, 'blocked', 'os-offline')
  const out = d.at(DWELL * 3, 'blocked', 'os-offline')
  t.ok(out.row, 're-enabling the log records the standing state instead of suppressing it forever')
})

test('an emptied log restates a degradation that is still true', (t) => {
  const afterPurge = driver({ persisted: null })
  afterPurge.at(0, 'blocked', 'dht-unreachable')
  t.ok(afterPurge.at(DWELL, 'blocked', 'dht-unreachable').row)
})

test('evidence is chosen per kind so the two blocked shapes stay distinguishable', (t) => {
  // Every kind carries confidence, so the support bundle can say 'measured' vs 'predicted' for
  // any transition, not only the two that happened to record it.
  t.alike(evidenceFor(KIND_OFFLINE, { confidence: 'measured', interfaceKind: 'none' }), { confidence: 'measured', interfaceKind: 'none' })
  t.alike(evidenceFor(KIND_AT_RISK, { confidence: 'predicted', publicPort: 0 }), { confidence: 'predicted', publicPort: 0 })
  t.alike(
    evidenceFor(KIND_BLOCKED, { confidence: 'measured', peersDiscovered: 4, peersExhausted: 4 }),
    { confidence: 'measured', peersDiscovered: 4, peersExhausted: 4 },
  )
  t.alike(evidenceFor(KIND_RESTORED, { confidence: 'measured', peersConnected: 3 }), { confidence: 'measured', peersConnected: 3 })
  t.alike(
    evidenceFor(KIND_BLOCKED, {}),
    { confidence: null, peersDiscovered: 0, peersExhausted: 0 },
    'missing evidence degrades, never throws',
  )
})
