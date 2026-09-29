import test from 'brittle'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { makePeer } from '../helpers/peer-bee.js'
import { scaled } from '../helpers/bare-timing.js'
import { getStore } from '../../src/shared/core/store.js'
import { getProfileKey } from '../../src/shared/spaces/profile.js'
import { attachPeerCore, gateReplication, holdPeerCore, initReplicationGate, replicateOn, resetReplicationGate } from '../../src/shared/network/replication-gate.js'

// Our side runs the gate on a real Noise socket; the remote is a plain corestore that replicates
// everything, as any peer on the topic can. The remote needs nothing but a core key to ask for a
// core, so each case hands it one.
async function connect(t) {
  // The swarm wires the gate's store; these tests boot without one.
  initReplicationGate({ getStore })
  t.teardown(resetReplicationGate)
  const remote = await makePeer(t)
  const ours = new NoiseSecretStream(true)
  const theirs = new NoiseSecretStream(false)
  ours.rawStream.pipe(theirs.rawStream).pipe(ours.rawStream)
  for (const s of [ours, theirs]) s.on('error', () => {})
  t.teardown(() => { ours.destroy(); theirs.destroy() })
  gateReplication(ours)
  remote.store.replicate(theirs)
  await ours.opened
  return { ours, remote }
}

async function mirrorOf(remote, key) {
  const core = remote.store.get({ key })
  await core.ready()
  return core
}

// A missing block is the assertion's subject, so it is reported, not thrown.
const firstBlock = (core, ms) => core.get(0, { timeout: scaled(ms) }).catch(() => null)

// Long enough for a request to cross the in-process pipe many times over.
const settle = (ms = 300) => new Promise((resolve) => setTimeout(resolve, scaled(ms)))

test('REGRESSION (MIR-47: a socket nobody admitted replicates none of our cores)', async (t) => {
  await freshPeer(t)
  const { remote } = await connect(t)
  const mirror = await mirrorOf(remote, getProfileKey())

  t.is(await firstBlock(mirror, 1500), null, 'no block of our profile reaches the remote')
  t.is(mirror.length, 0, 'nor its length')
})

test('admitting the socket replicates our cores, once', async (t) => {
  await freshPeer(t)
  const { ours, remote } = await connect(t)
  const mirror = await mirrorOf(remote, getProfileKey())
  await settle()

  t.ok(replicateOn(ours), 'the gated socket attaches')
  t.ok(await firstBlock(mirror, 5000), 'the remote reads our profile')
  t.absent(replicateOn(ours), 'a second admission attaches nothing more')
})

test('REGRESSION (MIR-47: a core the remote asked for before admission replicates after it)', async (t) => {
  await freshPeer(t)
  // Held on disk but not downloading here, so attaching the store alone never opens its channel.
  const held = getStore().get({ name: 'gate-early-ask', active: false })
  await held.ready()
  await held.append('early')
  t.teardown(() => held.close())

  const { ours, remote } = await connect(t)
  const mirror = await mirrorOf(remote, held.key)
  await settle()

  t.ok(replicateOn(ours), 'the gated socket attaches')
  t.ok(await firstBlock(mirror, 5000), 'the core it asked for early is offered and read')
})

test('REGRESSION (MIR-47: a peer\'s own core read over its socket serves it nothing else)', async (t) => {
  await freshPeer(t)
  const { ours, remote } = await connect(t)
  const mirror = await mirrorOf(remote, getProfileKey())
  await settle()

  const theirs = await attachPeerCore(ours, remote.key)
  t.teardown(() => theirs?.close())
  t.ok(theirs && await firstBlock(theirs, 5000), 'we read the peer\'s own core over its socket')
  t.is(await firstBlock(mirror, 1500), null, 'while it still reads nothing of ours')
  t.is(await attachPeerCore(ours, 'not-a-key'), null, 'a malformed key attaches nothing')
})

test('REGRESSION (FIX-551: a core held on a gated socket is served there and nothing else is)', async (t) => {
  await freshPeer(t)
  const held = getStore().get({ name: 'gate-held-other', active: false })
  await held.ready()
  await held.append('other')
  t.teardown(() => held.close())

  const { ours, remote } = await connect(t)
  const mirror = await mirrorOf(remote, getProfileKey())
  const other = await mirrorOf(remote, held.key)
  await settle()

  t.ok(await holdPeerCore(ours, b4a.toString(getProfileKey(), 'hex')), 'the gated socket holds our profile core')
  t.ok(await firstBlock(mirror, 5000), 'the remote reads it')
  t.is(await firstBlock(other, 1500), null, 'and no other core of ours')
})

test('a socket that already replicates holds nothing extra', async (t) => {
  await freshPeer(t)
  const { ours } = await connect(t)
  replicateOn(ours)

  t.absent(await holdPeerCore(ours, b4a.toString(getProfileKey(), 'hex')), 'an admitted socket is left to the store')
  t.absent(await holdPeerCore(ours, 'not-a-key'), 'as is a malformed key')
})

test('a socket that closed before admission is never attached', async (t) => {
  await freshPeer(t)
  const { ours } = await connect(t)
  ours.destroy()

  t.absent(replicateOn(ours), 'a closing socket is refused')
  t.absent(replicateOn({}), 'as is one the gate never saw')
})
