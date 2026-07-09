import test from 'brittle'
import { createPresence, presenceFrameKind } from '../../src/shared/state/presence.js'

// The receiver decision for an inbound presence frame (B1 departure): a well-formed frame with
// offline:true is a graceful-quit departure (clear the lease), a well-formed heartbeat marks
// online, and a malformed frame is ignored. This is the only deterministic coverage for the
// departure branch — swarm.js is a bare module and the flow socket-close path flips presence first.
test('presenceFrameKind: offline flag → clear, heartbeat → mark, malformed → ignore', (t) => {
  const ok = { profileKey: 'aa', spaceTopic: 'bb' }
  t.is(presenceFrameKind({ ...ok, offline: true }), 'clear', 'graceful-quit departure clears the lease')
  t.is(presenceFrameKind(ok), 'mark', 'heartbeat marks online')
  t.is(presenceFrameKind({ ...ok, offline: 'yes' }), 'mark', 'only strict true is a departure (no truthy coercion)')
  t.is(presenceFrameKind({ ...ok, offline: false }), 'mark', 'offline:false is a normal heartbeat')
  t.is(presenceFrameKind({ profileKey: 'aa' }), 'ignore', 'missing spaceTopic → ignore')
  t.is(presenceFrameKind({ spaceTopic: 'bb' }), 'ignore', 'missing profileKey → ignore')
  t.is(presenceFrameKind(null), 'ignore', 'malformed → ignore')
})

// Controllable clock so lease expiry is deterministic.
function fakeClock (start = 1000) {
  let t = start
  return { now: () => t, advance: (ms) => { t += ms } }
}

test('mark → online until the lease expires', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('alice', 'space-1')
  t.ok(p.isOnline('alice', 'space-1'), 'online right after mark')
  clk.advance(14999)
  t.ok(p.isOnline('alice', 'space-1'), 'still online just before TTL')
  clk.advance(2)
  t.absent(p.isOnline('alice', 'space-1'), 'offline once the lease expires')
})

test('a heartbeat refreshes the lease', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('bob', 'space-1')
  clk.advance(10000)
  p.mark('bob', 'space-1')           // heartbeat
  clk.advance(10000)                 // 20s since first mark, 10s since refresh
  t.ok(p.isOnline('bob', 'space-1'), 'refreshed lease keeps it online past the original TTL')
})

test('presence is per space', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('carol', 'space-1')
  t.ok(p.isOnline('carol', 'space-1'))
  t.absent(p.isOnline('carol', 'space-2'), 'not online in a space it never reported')
})

test('clear(peer) drops every space (disconnect)', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('dave', 'space-1'); p.mark('dave', 'space-2')
  p.clear('dave')
  t.absent(p.isOnline('dave', 'space-1'))
  t.absent(p.isOnline('dave', 'space-2'))
})

test('clear(peer, space) drops only that space', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('erin', 'space-1'); p.mark('erin', 'space-2')
  p.clear('erin', 'space-1')
  t.absent(p.isOnline('erin', 'space-1'))
  t.ok(p.isOnline('erin', 'space-2'), 'other space unaffected')
})

// The departure ('offline:true') receiver gates its reconcile emit on this return, so repeated or
// late departure frames don't amplify — clear reports a real online→offline flip, like mark.
test('clear reports whether it dropped a live lease (offline flip)', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('alice', 'S1')
  t.ok(p.clear('alice', 'S1'), 'clearing a live lease is a flip')
  t.absent(p.clear('alice', 'S1'), 'clearing an already-absent lease is not a flip')
  p.mark('bob', 'S1')
  clk.advance(16000)
  t.absent(p.clear('bob', 'S1'), 'clearing an already-expired lease is not a flip')
})

test('onlineIn returns the fresh peers for a space', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('a', 'S'); p.mark('b', 'S'); p.mark('c', 'other')
  t.alike([...p.onlineIn('S')].sort(), ['a', 'b'])
  clk.advance(16000)
  t.alike([...p.onlineIn('S')], [], 'all expired')
})

test('isOnlineAnywhere is true while any lease is fresh', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('owner', 'S1')
  t.ok(p.isOnlineAnywhere('owner'))
  t.absent(p.isOnlineAnywhere('stranger'))
  clk.advance(16000)
  t.absent(p.isOnlineAnywhere('owner'), 'offline once the only lease expired')
})

test('prune drops expired leases (housekeeping)', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  p.mark('x', 'S')
  clk.advance(16000)
  p.prune()
  // still reports offline (and the entry is gone) — onlineIn empty without scanning stale.
  t.alike([...p.onlineIn('S')], [])
  t.absent(p.isOnline('x', 'S'))
})

test('REGRESSION (FIX-EDA-3: prune fires onExpire for each silent-death lease so expiry re-emits)', (t) => {
  const clk = fakeClock()
  const expired = []
  const p = createPresence({ ttl: 15000, now: clk.now, onExpire: (peerKey, spaceId) => expired.push([peerKey, spaceId]) })
  p.mark('alice', 'S1')
  p.mark('alice', 'S2')
  p.mark('bob', 'S1')
  clk.advance(16000)
  p.prune()
  t.is(expired.length, 3, 'one onExpire per (peer, space) lease that lapsed')
  t.alike(expired.sort(), [['alice', 'S1'], ['alice', 'S2'], ['bob', 'S1']])
  expired.length = 0
  p.prune()
  t.is(expired.length, 0, 'a second prune does not re-fire — expiry is a one-shot transition')
})

test('onExpire does not fire for a still-fresh lease', (t) => {
  const clk = fakeClock()
  const expired = []
  const p = createPresence({ ttl: 15000, now: clk.now, onExpire: (k, s) => expired.push([k, s]) })
  p.mark('alice', 'S1')
  clk.advance(14999)
  p.prune()
  t.is(expired.length, 0, 'a lease inside its TTL is not expired')
})

// REGRESSION (FIX-EDA-10: a presence frame arriving after the lease expired on a still-open
// socket reset the TTL silently — mark returned nothing, so the caller could not mirror the
// onExpire emit and the peer stayed shown offline until an unrelated event).
test('REGRESSION (FIX-EDA-10): mark reports the offline→online flip', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  t.ok(p.mark('alice', 'S1'), 'a fresh lease is a flip')
  t.absent(p.mark('alice', 'S1'), 'a refresh inside the TTL is not a flip')
  clk.advance(10000)
  t.absent(p.mark('alice', 'S1'), 'a heartbeat refresh is not a flip')
  clk.advance(16000)
  t.ok(p.mark('alice', 'S1'), 'restoring an expired lease is a flip (same socket, no re-handshake)')
})

test('mark flips again after a prune consumed the expired lease', (t) => {
  const clk = fakeClock()
  const expired = []
  const p = createPresence({ ttl: 15000, now: clk.now, onExpire: (k, s) => expired.push([k, s]) })
  p.mark('alice', 'S1')
  clk.advance(16000)
  p.prune()
  t.is(expired.length, 1, 'expiry fired')
  t.ok(p.mark('alice', 'S1'), 'the next mark after the expiry is a flip again')
})

test('mark flips per space independently', (t) => {
  const clk = fakeClock()
  const p = createPresence({ ttl: 15000, now: clk.now })
  t.ok(p.mark('alice', 'S1'))
  t.ok(p.mark('alice', 'S2'), 'a second space is its own flip')
  t.absent(p.mark('alice', 'S1'), 'the first space is still fresh')
})
