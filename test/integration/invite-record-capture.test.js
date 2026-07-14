import test from 'brittle'
import b4a from 'b4a'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { makePeer, replicate } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { capturePeerBee, captureJoinerMembership, peerBeeLength, readPeerInvite, readPeerInviteSnapshot, openProfileBee } from '../../src/shared/spaces/profile.js'
import { resolveInvite } from '../../src/shared/transfer/swarm.js'
import { classifyInvite } from '../../src/shared/spaces/invite-policy.js'

const SPACE = 'space-cap'
const AUTO = { autoApprove: true, expiresAt: null, created: 1 }

// src/shared modules are process-global singletons; restore any config a test mutates so
// it cannot leak into the rest of the file (a stray captureMemberRecordMs:0 disables capture
// for every later test).
function withConfig (t, patch) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, ...patch })
  t.teardown(() => setRuntimeConfig(prev))
}

function shrinkPeerReads (t) {
  withConfig(t, { peerReadTimeoutMs: 500 })
}

async function grow (peer, n, label) {
  for (let i = 0; i < n; i++) await peer.bee.put('filler/' + label + '/' + i, i)
}

async function syncKnownLength (key) {
  const core = openProfileBee(b4a.from(key, 'hex')).core
  await core.ready()
  await core.update({ wait: true })
}

function spaceWith (peerKey) {
  return { spaceId: SPACE, members: [{ publicKey: peerKey }] }
}

// REGRESSION (FIX-3: co-member invite enforcement dies with the minter): the minter's
// bee grew past our sparse copy, then the minter went offline — a live read walks the
// new root and hangs on missing blocks, so pre-fix the record was unreachable and an
// auto link fell back to the manual banner. With the captured contiguous prefix, the
// snapshot fallback still resolves it.
test('REGRESSION (FIX-3): captured record resolves after the minter goes offline', async (t) => {
  await freshPeerWithIdentity(t)
  shrinkPeerReads(t)
  const peer = await makePeer(t)
  await peer.bee.put('invite/' + SPACE + '/aaaa', AUTO)
  const streams = replicate(peer.store, getStore(), t)

  const r = await capturePeerBee(peer.key)
  t.ok(r.complete, `capture completed (${r.contiguous}/${r.length})`)

  await grow(peer, 5, 'post')
  await syncKnownLength(peer.key)
  streams.destroy()

  t.is(await readPeerInvite(peer.key, SPACE, 'aaaa'), null, 'live read fails offline (new root, missing blocks)')
  const snap = await readPeerInviteSnapshot(peer.key, SPACE, 'aaaa')
  t.ok(snap, 'snapshot read answers from the captured contiguous prefix')
  t.is(snap.autoApprove, true)

  const rec = await resolveInvite(spaceWith(peer.key), 'aaaa')
  t.ok(rec, 'resolveInvite falls back to the snapshot')
  t.is(rec.stale, true, 'fallback record is marked stale')
  t.is(classifyInvite(rec), 'auto', 'auto policy enforceable with the minter offline')
})

// REGRESSION (FIX-3, control): without a capture, a sparse replica cannot answer once
// the minter is offline — the pre-fix reality this feature exists to remove.
test('REGRESSION (FIX-3, control): without capture the offline read fails', async (t) => {
  await freshPeerWithIdentity(t)
  shrinkPeerReads(t)
  const peer = await makePeer(t)
  await peer.bee.put('invite/' + SPACE + '/bbbb', AUTO)
  await grow(peer, 40, 'pad')
  const streams = replicate(peer.store, getStore(), t)

  const bee = openProfileBee(b4a.from(peer.key, 'hex'))
  await bee.ready()
  await bee.core.update({ wait: true })
  await bee.get('caps/membership-manifest')
  streams.destroy()

  t.is(await readPeerInviteSnapshot(peer.key, SPACE, 'bbbb'), null, 'sparse prefix cannot answer')
  t.is(await resolveInvite(spaceWith(peer.key), 'bbbb'), null, 'enforcement unavailable — pre-fix behavior pinned')
})

test('capture is idempotent and complete on a small bee', async (t) => {
  await freshPeerWithIdentity(t)
  const peer = await makePeer(t)
  await peer.bee.put('invite/' + SPACE + '/cccc', AUTO)
  replicate(peer.store, getStore(), t)

  const first = await capturePeerBee(peer.key)
  t.ok(first.complete)
  t.is(first.contiguous, first.length, 'contiguous copy held')
  const again = await capturePeerBee(peer.key)
  t.ok(again.complete, 'second capture is a no-op success')
  t.is(again.contiguous, first.contiguous)
})

// A bee larger than the sweep budget is as captured as it will ever be: it must report
// `capped` so the scheduler retires it, instead of an eternal incomplete deficit.
test('capture honors the block cap, reports capped, and does not hang', async (t) => {
  await freshPeerWithIdentity(t)
  const peer = await makePeer(t)
  await grow(peer, 60, 'cap')
  replicate(peer.store, getStore(), t)

  const r = await capturePeerBee(peer.key, { maxBlocks: 10 })
  t.is(r.complete, true, 'complete relative to the cap — the prefix is all we will hold')
  t.is(r.capped, true, 'capped flags the un-capturable tail')
  t.ok(r.contiguous >= 10 && r.contiguous < r.length, `stopped at the cap (${r.contiguous}/${r.length})`)
})

test('capture leaves no open core sessions behind', async (t) => {
  await freshPeerWithIdentity(t)
  const peer = await makePeer(t)
  await peer.bee.put('invite/' + SPACE + '/sess', AUTO)
  replicate(peer.store, getStore(), t)

  const probe = openProfileBee(b4a.from(peer.key, 'hex'))
  await probe.ready()
  const before = probe.core.sessions.length
  for (let i = 0; i < 5; i++) {
    await capturePeerBee(peer.key)
    await peerBeeLength(peer.key)
    await readPeerInviteSnapshot(peer.key, SPACE, 'sess')
  }
  t.is(probe.core.sessions.length, before, 'capture/length/snapshot all close what they open')
  await probe.close()
})

// captureMemberRecordMs<=0 is the documented kill switch for capture work.
test('captureMemberRecordMs 0 disables the approval-time capture', async (t) => {
  await freshPeerWithIdentity(t)
  const peer = await makePeer(t)
  replicate(peer.store, getStore(), t)
  withConfig(t, { captureMemberRecordMs: 0 })
  t.is(await captureJoinerMembership(peer.key, SPACE), false, 'capture disabled by config')
})

test('captureJoinerMembership captures the joiner durably via explicit gets', async (t) => {
  await freshPeerWithIdentity(t)
  const peer = await makePeer(t)
  await peer.bee.put('member/' + SPACE, { active: true, ts: 1 })
  const streams = replicate(peer.store, getStore(), t)

  t.is(await captureJoinerMembership(peer.key, SPACE), true, 'joiner record captured while connected')
  streams.destroy()

  const bee = openProfileBee(b4a.from(peer.key, 'hex'))
  await bee.ready()
  t.is(bee.core.contiguousLength, bee.core.length, 'contiguous copy survives the disconnect')
  await bee.close()
})

test('growth re-capture picks up records minted after the first capture', async (t) => {
  await freshPeerWithIdentity(t)
  shrinkPeerReads(t)
  const peer = await makePeer(t)
  await peer.bee.put('invite/' + SPACE + '/dddd', AUTO)
  const streams = replicate(peer.store, getStore(), t)

  t.ok((await capturePeerBee(peer.key)).complete)
  await peer.bee.put('invite/' + SPACE + '/eeee', AUTO)
  // Wait for the new head to actually replicate. capturePeerBee's internal refresh is
  // hard-capped at 1s; if the append hasn't landed by then it captures the stale length,
  // reports complete vacuously, and never sweeps `eeee` — so the snapshot read below
  // fails. Every other test in this file syncs first; this one raced that 1s budget.
  await syncKnownLength(peer.key)
  t.ok((await capturePeerBee(peer.key)).complete, 're-capture covers the growth')
  streams.destroy()

  t.ok(await readPeerInviteSnapshot(peer.key, SPACE, 'dddd'))
  t.ok(await readPeerInviteSnapshot(peer.key, SPACE, 'eeee'), 'later record captured too')
})

test('a revocation replicated before going offline is honored by the snapshot', async (t) => {
  await freshPeerWithIdentity(t)
  shrinkPeerReads(t)
  const peer = await makePeer(t)
  await peer.bee.put('invite/' + SPACE + '/ffff', AUTO)
  const streams = replicate(peer.store, getStore(), t)

  t.ok((await capturePeerBee(peer.key)).complete)
  await peer.bee.del('invite/' + SPACE + '/ffff')
  t.ok((await capturePeerBee(peer.key)).complete, 'del captured into the prefix')
  streams.destroy()

  t.is(await readPeerInviteSnapshot(peer.key, SPACE, 'ffff'), null, 'snapshot sees the revocation')
  t.is(await resolveInvite(spaceWith(peer.key), 'ffff'), null)
})

// No shrinkPeerReads here: every read below is on the *success* path, with the peer still
// connected. That helper exists to make the OFFLINE tests fail fast, and a 500ms budget on
// a read that is supposed to resolve just turns CPU contention into a timeout — which
// returns null, makes the peer a snapshot candidate, and resurrects the revoked record.
// The test would then fail on precisely the outcome it exists to forbid. The 8s default
// costs nothing here, because these reads resolve promptly when they resolve at all.
test('live-absent is authoritative: a revoked link is not resurrected from a stale snapshot', async (t) => {
  await freshPeerWithIdentity(t)
  const peer = await makePeer(t)
  await peer.bee.put('invite/' + SPACE + '/gggg', AUTO)
  replicate(peer.store, getStore(), t)

  t.ok((await capturePeerBee(peer.key)).complete)
  const live = await readPeerInvite(peer.key, SPACE, 'gggg')
  t.ok(live?.resolved && live.value?.autoApprove, 'live read resolves the record while connected')

  await peer.bee.del('invite/' + SPACE + '/gggg')
  const gone = await readPeerInvite(peer.key, SPACE, 'gggg')
  t.ok(gone?.resolved, 'live read still answers')
  t.is(gone.value, null, 'record authoritatively absent')

  t.is(await resolveInvite(spaceWith(peer.key), 'gggg'), null, 'live-absent wins — no snapshot fallback while reachable')
})

test('an expired record stays expired when read from the snapshot', async (t) => {
  await freshPeerWithIdentity(t)
  shrinkPeerReads(t)
  const peer = await makePeer(t)
  await peer.bee.put('invite/' + SPACE + '/hhhh', { autoApprove: true, expiresAt: 5, created: 1 })
  const streams = replicate(peer.store, getStore(), t)

  t.ok((await capturePeerBee(peer.key)).complete)
  await grow(peer, 3, 'exp')
  await syncKnownLength(peer.key)
  streams.destroy()

  const rec = await resolveInvite(spaceWith(peer.key), 'hhhh')
  t.ok(rec?.stale, 'resolved via snapshot')
  t.is(classifyInvite(rec), 'expired', 'expiry enforced on stale reads — offline deny path intact')
})
