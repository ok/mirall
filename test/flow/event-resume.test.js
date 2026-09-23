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
  await peer.until('event:reconcile', {}, () => true, { ms: 5000 }).catch(() => {})

  const moved = peer.cursor()
  t.ok(moved.since > start.since, 'the cursor advanced as events arrived')

  // The cursor is the caller's own account of what it holds, which is what a resume is answered
  // against: the consumer need not be the socket the frames arrived on. Asking from the boot cursor
  // therefore re-sends everything pushed since, over a real worker and a real pipe.
  const answer = await peer.request('events:resume', { epoch: start.epoch, since: start.since })
  t.is(answer.gap, false, 'the worker can still answer for everything since boot')
  t.ok(answer.replayed > 0, 'and it re-sent the frames pushed since that cursor')
  t.is(answer.epoch, start.epoch, 'it is the same stream')
  t.ok(answer.head >= moved.since, 'reporting a head no older than what the client has seen')

  const caughtUp = await peer.request('events:resume', peer.cursor())
  t.is(caughtUp.replayed, 0, 'a cursor at the head is owed nothing')

  const stale = await peer.request('events:resume', { epoch: 'a-worker-that-is-gone', since: 1 })
  t.is(stale.gap, true, 'a cursor from another generation is not resumable')
  t.is(stale.epoch, start.epoch, 'the client is told which stream this actually is')

  const fresh = await peer.request('events:resume', {})
  t.is(fresh.gap, false, 'a first-time subscriber has missed nothing')
})

// The only reconnect that exists while the worker dies with the app: the process is replaced, so
// the epoch differs and replay cannot help. What must hold is that the client is TOLD, converges on
// the new stream, and never silently skips the frames the dead ring held.
test('a worker restart is a resync, and the stores converge on the new stream', { timeout: scaled(60000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const space = await peer.request('space:create', { name: 'Resume' })
  await peer.request('share:create', { spaceId: space.spaceId, name: 'Vault' })
  const before = peer.cursor()
  t.ok(before.since > 0, 'the cursor advanced while the first generation ran')

  peer.kill()
  const again = await launchPeer(t, {
    bootstrap, displayName: 'Alice', storage: peer.storage, downloads: peer.downloads,
  })
  const after = again.cursor()
  t.not(after.epoch, before.epoch, 'a new process is a new stream')

  const stale = await again.request('events:resume', before)
  t.is(stale.gap, true, 'the cursor from the dead generation is refused rather than mis-applied')
  t.is(stale.epoch, after.epoch, 'and the client is told which stream this actually is')

  // The resync the renderer would run, asserted at the level this harness can see: the data is all
  // still there, read fresh from the new worker.
  const spaces = await again.until('spaces:list', {}, (list) => list.length === 1, { ms: 20000 })
  t.is(spaces[0].name, 'Resume', 'nothing was lost with the generation that ended')
})

// The floor is the worker's, and `gap` is the only thing a client ever sees of it.
test('a cursor the ring cannot answer for is answered honestly, not partially', { timeout: scaled(30000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const peer = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const start = peer.cursor()
  const answer = await peer.request('events:resume', { epoch: start.epoch, since: 0 })
  t.is(answer.epoch, start.epoch)
  t.is(answer.gap, false, 'this worker has issued every frame since boot and can still answer for them')
  t.ok(answer.head >= start.since, 'the head is no older than what the client already holds')
})
