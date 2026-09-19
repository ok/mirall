import test from 'brittle'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { scaled } from '../helpers/timing.js'

// A client that misses a window converges. One peer, no swarm work — what is under test is the
// worker's own event stream, so nothing here waits on the network.
test('a client resumes from its cursor and is told honestly when it cannot', { timeout: scaled(30000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice' })

  const start = peer.cursor()
  t.ok(start.epoch, 'the greeting carried the stream this worker is on')

  // Real mutations, so the frames replayed are ones the worker genuinely pushed.
  const space = await peer.request('space:create', { name: 'Resume' })
  await peer.request('share:create', { spaceId: space.spaceId, name: 'Vault' })
  await peer.until('event:reconcile', {}, () => true, { ms: scaled(5000) }).catch(() => {})

  const moved = peer.cursor()
  t.ok(moved.since > start.since, 'the cursor advanced as events arrived')

  // This peer never disconnected, so it received every frame live and is owed none of them back.
  // A real replay needs a second connection to one worker, which the harness cannot make — one
  // pipe per peer — so it is pinned at the integration layer instead. What this proves end to end
  // is the rest: the contract row, the handler, ctx.client, and the epoch the greeting carried.
  const answer = await peer.request('events:resume', { epoch: start.epoch, since: start.since })
  t.is(answer.gap, false, 'the worker can still answer for everything since boot')
  t.is(answer.replayed, 0, 'and re-sends nothing this client already has')
  t.is(answer.epoch, start.epoch, 'it is the same stream')
  t.ok(answer.head >= moved.since, 'reporting a head no older than what the client has seen')

  const stale = await peer.request('events:resume', { epoch: 'a-worker-that-is-gone', since: 1 })
  t.is(stale.gap, true, 'a cursor from another generation is not resumable')
  t.is(stale.epoch, start.epoch, 'the client is told which stream this actually is')

  const fresh = await peer.request('events:resume', {})
  t.is(fresh.gap, false, 'a first-time subscriber has missed nothing')
})
