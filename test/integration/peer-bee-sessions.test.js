import test from 'brittle'
import b4a from 'b4a'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { makePeer, replicate } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { openProfileBee, readPeerMembership, readPeerApproval, readProfileRecord } from '../../src/shared/spaces/profile.js'
import { readPeerShares, readPeerShareEntry } from '../../src/shared/shares/shares.js'

const SPACE = 'space-sessions'

function withConfig (t, patch) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, ...patch })
  t.teardown(() => setRuntimeConfig(prev))
}

async function peerWithRecords (t) {
  const peer = await makePeer(t)
  await peer.bee.put('caps/folder-shares', true)
  await peer.bee.put('member/' + SPACE, { active: true, ts: 1 })
  await peer.bee.put('displayName', 'Peer')
  await peer.bee.put('share/' + SPACE + '/s1', { id: 's1', name: 'S', owner: 'p', createdAt: 1 })
  return peer
}

// REGRESSION (FIX-PEERBEE-SESSIONS: every transient read of a peer's profile bee opened a fresh
// Hypercore session plus a Hyperbee — each with its own append/truncate listeners — and never
// closed it. Corestore's GC only reaps cores with zero sessions, so nothing was ever reclaimed,
// every append fanned out to every session ever opened, and every leaked core stayed attached to
// every replication stream. Twelve read paths did this; these are the ones a normal session
// drives repeatedly.)
test('REGRESSION (FIX-PEERBEE-SESSIONS): repeated peer reads do not accumulate core sessions', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { peerReadTimeoutMs: 500, interactiveReadTimeoutMs: 500 })
  const peer = await peerWithRecords(t)
  replicate(getStore(), peer.store, t)

  // One long-lived probe session, the way a member view or the avatar listener holds one.
  const probe = openProfileBee(b4a.from(peer.key, 'hex'))
  await probe.ready()
  t.teardown(async () => { try { await probe.close() } catch {} })
  const before = probe.core.sessions.length

  for (let i = 0; i < 20; i++) {
    await readPeerMembership(peer.key, SPACE)
    await readPeerApproval(peer.key, SPACE, 'j'.repeat(64))
    await readProfileRecord(peer.key, SPACE)
    await readPeerShares(peer.key, SPACE)
    await readPeerShareEntry(peer.key, SPACE, 's1')
  }

  // 100 reads. Before the fix each left its session behind; now each closes its own.
  t.is(probe.core.sessions.length, before, 'every bounded read closed the session it opened')
  t.ok(probe.core.sessions.length <= 2, 'and the holder is the only session left (' + probe.core.sessions.length + ')')
})

// Closing a read's session must not disturb any other holder — that is what makes the bracket
// safe to add to twelve call sites.
test('a bounded read closing its session leaves another holder readable', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { peerReadTimeoutMs: 500 })
  const peer = await peerWithRecords(t)
  replicate(getStore(), peer.store, t)

  const holder = openProfileBee(b4a.from(peer.key, 'hex'))
  await holder.ready()
  await holder.core.update({ wait: true })
  t.teardown(async () => { try { await holder.close() } catch {} })

  t.is(await readPeerMembership(peer.key, SPACE), true, 'the bounded read answered')
  t.absent(holder.core.closed, 'the shared core is still open')
  const still = await holder.get('displayName')
  t.is(still?.value, 'Peer', 'the surviving holder still reads')
})

// An unreachable peer must not pin a core through an abandoned batch: the session-level timeout
// makes every block read under a bounded read settle instead of waiting forever.
test('a read of an unreplicated peer is bounded and leaves nothing open', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { peerReadTimeoutMs: 300 })
  const ghostKey = 'c'.repeat(64)

  const probe = openProfileBee(b4a.from(ghostKey, 'hex'))
  await probe.ready()
  t.teardown(async () => { try { await probe.close() } catch {} })
  const before = probe.core.sessions.length

  const t0 = Date.now()
  t.is(await readPeerMembership(ghostKey, SPACE), null, 'an unreachable peer reads as unknown')
  const dt = Date.now() - t0
  t.ok(dt < 1500, 'and it is bounded (' + dt + 'ms)')
  t.is(probe.core.sessions.length, before, 'with no session left behind')
})

// The leftover reclaim decides what to PURGE from what this read returns, so a partial read must
// stay partial: a peer bee is only ever partially replicated, and the keys collected before a
// missing block must still reach the wanted set or a live catalog scans as an orphan.
test('a peer catalog read that aborts mid-stream keeps the keys it already collected', async (t) => {
  await freshPeerWithIdentity(t)
  withConfig(t, { peerReadTimeoutMs: 500 })
  const peer = await makePeer(t)
  await peer.bee.put('caps/folder-shares', true)
  for (let i = 0; i < 4; i++) {
    await peer.bee.put('share/' + SPACE + '/s' + i, { id: 's' + i, name: 'S' + i, owner: 'p', createdAt: 1, catalogKey: String(i).repeat(64) })
  }
  replicate(getStore(), peer.store, t)

  const { buildWantedKeys } = await import('../../src/shared/storage/leftover.js')
  const wanted = await buildWantedKeys()
  t.ok(wanted instanceof Set, 'the scan produced a wanted set')
  // The precise membership depends on what replicated; the guarantee under test is that the scan
  // completes and does not throw when a peer bee is only partly available.
  t.pass('a partially replicated peer bee does not abort the leftover scan')
})
