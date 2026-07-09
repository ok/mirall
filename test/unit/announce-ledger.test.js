import test from 'brittle'
import { createAnnounceLedger, escalationDue, announceStatus } from '../../src/shared/transfer/announce-ledger.js'

const CFG = { baseMs: 1000, capMs: 8000, maxAttempts: 3 }
const never = () => false
const due = (l, now, isSettled = never) => l.due({ now, ...CFG, isSettled })

test('backoff schedule: attempt n waits base·2^(n-1), capped', (t) => {
  const l = createAnnounceLedger()
  l.recordSend('s1', 'sp1', 'request', 0)
  t.alike(due(l, 999), [], 'not due before base elapses')
  t.alike(due(l, 1000), [{ socketId: 's1', spaceId: 'sp1', kind: 'request' }], 'due after base')

  l.recordSend('s1', 'sp1', 'request', 1000)
  t.alike(due(l, 2999), [], 'second attempt backs off 2·base')
  t.is(due(l, 3000).length, 1, 'due after 2·base')

  for (let i = 0; i < 6; i++) l.recordSend('s1', 'sp1', 'request', 10_000)
  t.alike(due(l, 17_999), [], 'high attempt counts wait only capMs')
  t.is(due(l, 18_000).length, 1, 'capped at capMs, never longer')
})

test('handshake kind gives up at maxAttempts; request kind heartbeats forever', (t) => {
  const l = createAnnounceLedger()
  for (let i = 0; i < 3; i++) l.recordSend('s1', 'hs', 'handshake', 0)
  for (let i = 0; i < 3; i++) l.recordSend('s1', 'req', 'request', 0)
  const d = due(l, 100_000)
  t.alike(d.map((e) => e.spaceId), ['req'], 'handshake at maxAttempts dropped from due; request still heartbeats')
})

test('settled entries are pruned on due(), and empty socket buckets evaporate', (t) => {
  const l = createAnnounceLedger()
  l.recordSend('s1', 'sp1', 'handshake', 0)
  l.recordSend('s1', 'sp2', 'handshake', 0)
  const settled = (socketId, spaceId) => spaceId === 'sp1'
  t.alike(due(l, 1000, settled).map((e) => e.spaceId), ['sp2'], 'settled sp1 pruned, sp2 due')
  t.is(l.lastSentAt('s1', 'sp1'), 0, 'pruned entry reads as never-sent')
  const allSettled = () => true
  t.alike(due(l, 1000, allSettled), [], 'everything settled → nothing due')
  l.recordSend('s1', 'sp3', 'handshake', 0)
  t.is(l.lastSentAt('s1', 'sp3'), 0 + 0, 'bucket recreated after evaporation')
})

test('forgetSocket/clear prune as named; lastSentAt defaults to 0', (t) => {
  const l = createAnnounceLedger()
  l.recordSend('s1', 'sp1', 'request', 500)
  t.is(l.lastSentAt('s1', 'sp1'), 500)
  t.is(l.lastSentAt('s1', 'nope'), 0, 'unknown space → 0')
  t.is(l.lastSentAt('s2', 'sp1'), 0, 'unknown socket → 0')
  l.forgetSocket('s1')
  t.alike(due(l, 100_000), [], 'forgotten socket gone')
  l.recordSend('s1', 'sp1', 'request', 0)
  l.clear()
  t.alike(due(l, 100_000), [], 'clear empties everything')
})

test('re-recording after an inline settle restarts the attempt count (fresh backoff)', (t) => {
  const l = createAnnounceLedger()
  l.recordSend('s1', 'sp1', 'handshake', 0)
  l.recordSend('s1', 'sp1', 'handshake', 0)
  due(l, 1, () => true)   // isSettled → prune inline
  l.recordSend('s1', 'sp1', 'handshake', 10_000)
  t.is(due(l, 11_000).length, 1, 'first attempt after settle waits only base again')
})

test('spaceIds() returns the distinct pending spaces across sockets', (t) => {
  const l = createAnnounceLedger()
  l.recordSend('s1', 'sp1', 'handshake', 0)
  l.recordSend('s1', 'sp2', 'request', 0)
  l.recordSend('s2', 'sp1', 'handshake', 0)
  t.alike([...l.spaceIds()].sort(), ['sp1', 'sp2'], 'union of spaces, deduped')
  l.forgetSocket('s1'); l.forgetSocket('s2')
  t.alike([...l.spaceIds()], [], 'empty after all sockets forgotten')
})

test('a handshake at maxAttempts is DELETED (bucket evaporates), not just skipped', (t) => {
  const l = createAnnounceLedger()
  for (let i = 0; i < 3; i++) l.recordSend('s1', 'hs', 'handshake', 0)   // maxAttempts=3
  t.alike(due(l, 100_000), [], 'gave-up handshake is not due')
  t.alike([...l.spaceIds()], [], 'and it was pruned, so the socket bucket is gone')
})

test('REGRESSION (FIX-0): announceStatus treats a present statusless space as active, only a null space as settled', (t) => {
  t.is(announceStatus(null), null, 'gone space → null → the ledger settles (nothing to announce)')
  t.is(announceStatus(undefined), null, 'absent space → null')
  t.is(announceStatus({}), 'active', 'owner-created / v1 space carries no status → active (re-announce stays alive)')
  t.is(announceStatus({ status: 'pending' }), 'pending', 'a pending joiner space keeps its status')
  t.is(announceStatus({ status: 'approved' }), 'approved', 'an approved joiner space keeps its status')
})

test('escalationDue: needs both persistence and refresh spacing', (t) => {
  const base = { escalateTicks: 4, minMs: 300_000 }
  t.absent(escalationDue({ ...base, ticks: 3, lastRefreshAt: 0, now: 1_000_000 }), 'not persistent enough')
  t.ok(escalationDue({ ...base, ticks: 4, lastRefreshAt: 0, now: 1_000_000 }), 'persistent + never refreshed → due')
  t.absent(escalationDue({ ...base, ticks: 10, lastRefreshAt: 900_000, now: 1_000_000 }), 'refreshed recently → throttled')
  t.ok(escalationDue({ ...base, ticks: 10, lastRefreshAt: 700_000, now: 1_000_000 }), 'window elapsed → due again')
})
