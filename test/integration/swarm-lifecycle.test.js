import test from 'brittle'
import b4a from 'b4a'
import { localTestnet } from '../helpers/testnet.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { Swarm } from '../../src/shared/network/swarm.js'
import {
  registerPendingLeave, hasPendingLeave, markSpaceLeaving, isSpaceLeaving,
} from '../../src/shared/network/leave-protocol.js'
import { ContentSwarm, getContentSwarm } from '../../src/shared/network/content-swarm.js'
import { _compactStoreForTests } from '../../src/shared/storage/compaction.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { stubOverlayBackend } from '../helpers/overlay-stub.js'

async function swarmDeps(t) {
  const bootstrap = await localTestnet(t)
  setRuntimeConfig({ storage: null, dhtBootstrap: bootstrap })
  return {
    ipc: createFakeIpc().ipc,
    membershipControl: async () => {},
    overlayBackend: stubOverlayBackend,
    stalledOwners: () => [],
  }
}

// REGRESSION (LIFECYCLE-3a: destroySwarm reset 46 of swarm.js's 70 module bindings. The
// pending-leave replay registry and the leaving-space set both survived it, so a second boot in
// one process re-announced a leave for a space already gone and refused work on a space that was
// not leaving.)
test('REGRESSION (LIFECYCLE-3a): a closed swarm leaves no pending leave and no leaving space', async (t) => {
  const deps = await swarmDeps(t)
  const swarm = new Swarm('swarm', deps)
  await swarm.ready()
  registerPendingLeave('space-a', b4a.alloc(32, 1), Date.now())
  markSpaceLeaving('space-b')
  t.ok(hasPendingLeave('space-a'), 'the fixture armed a marker')
  t.ok(isSpaceLeaving('space-b'), 'and a leaving space')

  await swarm.close()

  t.absent(hasPendingLeave('space-a'), 'the replay registry is empty')
  t.absent(isSpaceLeaving('space-b'), 'and so is the leaving set')

  const second = new Swarm('swarm-2', deps)
  await second.ready()
  t.teardown(() => second.close())
  t.absent(hasPendingLeave('space-a'), 'a fresh swarm inherits neither')
  t.absent(isSpaceLeaving('space-b'))
})

// REGRESSION (LIFECYCLE-3b: initSwarm had no idempotence guard where initContentSwarm does, so a
// second start replaced the swarm and left the first live, undestroyed and unreachable.)
test('REGRESSION (LIFECYCLE-3b): starting a running swarm is refused, not silently replaced', async (t) => {
  const deps = await swarmDeps(t)
  const swarm = new Swarm('swarm', deps)
  await swarm.ready()
  t.teardown(() => swarm.close())
  const dht = swarm.dht

  const second = new Swarm('swarm-2', deps)
  await t.exception(second.ready(), /already running/)
  t.is(swarm.dht, dht, 'the running swarm is untouched')
})

// REGRESSION (LIFECYCLE-3c: the overlay's protocol must be torn down while the sockets its
// serve-end frames travel on are still up, or a transfer interrupted by quitting records nothing.)
test('REGRESSION (LIFECYCLE-3c): the overlay detaches before the swarm drops its connections', async (t) => {
  const order = []
  const deps = await swarmDeps(t)
  deps.overlayBackend = { ...stubOverlayBackend, detach: async () => { order.push('overlay-detach') } }
  const swarm = new Swarm('swarm', deps)
  await swarm.ready()
  const dht = swarm.dht
  const realDestroy = dht.destroy.bind(dht)
  dht.destroy = async (...args) => { order.push('dht-destroy'); return realDestroy(...args) }

  await swarm.close()
  t.alike(order, ['overlay-detach', 'dht-destroy'], 'detach precedes the teardown')
})

// The content swarm shares the control swarm's DHT node, so its close must leave topics and shut
// its own server without destroying that node.
test('closing the content swarm leaves the shared DHT node to the control swarm', async (t) => {
  const deps = await swarmDeps(t)
  const swarm = new Swarm('swarm', deps)
  await swarm.ready()
  t.teardown(() => swarm.close())
  const content = new ContentSwarm('content-swarm', { swarm, overlayBackend: stubOverlayBackend })
  await content.ready()
  const dht = swarm.dht

  await content.close()
  t.absent(getContentSwarm(), 'the content swarm is gone')
  t.absent(dht.destroyed, 'the shared DHT node survives')
})

// The compaction reads cores the durable tier closes moments later, so the close waits for it —
// but bounded: it runs under the runtime tier's shared budget, and a full-range compaction the
// user just started would otherwise spend the whole budget and skip every later subsystem.
test('a store compaction in flight is waited for, but only briefly', async (t) => {
  const deps = await swarmDeps(t)
  const swarm = new Swarm('swarm', deps)
  await swarm.ready()

  let released = null
  const blocked = new Promise((resolve) => { released = resolve })
  _compactStoreForTests(() => blocked)

  const t0 = Date.now()
  await swarm.close()
  const waited = Date.now() - t0
  released()

  t.ok(waited >= 200, 'the close waited for the compaction (' + waited + 'ms)')
  t.ok(waited < 1200, 'and gave up well inside the tier budget rather than blocking on it')
})
