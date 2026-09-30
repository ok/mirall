import test from 'brittle'
import b4a from 'b4a'
import Hypercore from 'hypercore'
import NoiseSecretStream from '@hyperswarm/secret-stream'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate } from '../helpers/peer-bee.js'
import { scaled } from '../helpers/bare-timing.js'
import { getStore } from '../../src/shared/core/store.js'
import { captureJoinerMembership } from '../../src/shared/spaces/profile.js'

// The approver captures the joiner's profile core right after sending the grant over the joiner's
// socket, while the joiner is still vetting it and serves nothing there yet. The joiner pairs once
// it has applied the grant; an absolute 200 ms stands in for that check.
const S = 'space-capture-head'
const JOINER_PAIRS_AFTER_MS = 200

async function joinerWithRecord(t, active = true) {
  const joiner = await makePeer(t)
  await joiner.bee.put('member/' + S, { active, ts: Date.now() })
  return joiner
}

// Our end of the joiner's open socket. The joiner's end is gated the way gateReplication gates it,
// refusing every core we open, and replicates its store after `afterMs`, as replicateOn does.
async function joinerSocket(t, joiner, afterMs = JOINER_PAIRS_AFTER_MS) {
  const ours = new NoiseSecretStream(true)
  const theirs = new NoiseSecretStream(false)
  for (const s of [ours, theirs]) s.on('error', () => {})
  ours.rawStream.pipe(theirs.rawStream).pipe(ours.rawStream)
  Hypercore.createProtocolStream(theirs, { ondiscoverykey() {} })
  getStore().replicate(ours)
  await ours.opened
  const timer = afterMs === null ? null : setTimeout(() => joiner.store.replicate(theirs), afterMs)
  t.teardown(() => { clearTimeout(timer); ours.destroy(); theirs.destroy() })
  return ours
}

async function localCopy(key) {
  const core = getStore().get({ key: b4a.from(key, 'hex') })
  await core.ready()
  const length = core.length
  const contiguous = core.contiguousLength
  await core.close()
  return { length, contiguous }
}

test('REGRESSION (FIX-553: the approval capture gave up before the joiner served its core)', async (t) => {
  await freshPeer(t)
  const joiner = await joinerWithRecord(t)
  const socket = await joinerSocket(t, joiner)

  t.ok(await captureJoinerMembership(joiner.key, S, { timeoutMs: scaled(5000), socket }), 'the capture waits for the joiner to pair')
})

test('REGRESSION (FIX-553: a co-member holding none of the joiner answered the capture first)', async (t) => {
  await freshPeer(t)
  const joiner = await joinerWithRecord(t)
  const coMember = await makePeer(t)
  const hollow = coMember.store.get({ key: b4a.from(joiner.key, 'hex') })
  await hollow.ready()
  replicate(getStore(), coMember.store, t)
  const socket = await joinerSocket(t, joiner)

  t.ok(await captureJoinerMembership(joiner.key, S, { timeoutMs: scaled(5000), socket }), 'the capture waits past the empty holder')
})

test('REGRESSION (FIX-553: a stale copy held by a co-member passed for the rejoining joiner\'s head)', async (t) => {
  await freshPeer(t)
  const joiner = await joinerWithRecord(t, false)
  const coMember = await makePeer(t)
  const stale = coMember.store.get({ key: b4a.from(joiner.key, 'hex') })
  await stale.ready()
  const seeding = replicate(joiner.store, coMember.store, t)
  await stale.download({ start: 0, end: joiner.bee.core.length }).done()
  seeding.destroy()
  const early = replicate(getStore(), joiner.store, t)
  t.ok(await captureJoinerMembership(joiner.key, S, { timeoutMs: scaled(5000) }), 'precondition: we hold the old copy too')
  early.destroy()

  await joiner.bee.put('member/' + S, { active: true, ts: Date.now() })
  replicate(getStore(), coMember.store, t)
  const socket = await joinerSocket(t, joiner)

  t.ok(await captureJoinerMembership(joiner.key, S, { timeoutMs: scaled(5000), socket }), 'the capture completes')
  const copy = await localCopy(joiner.key)
  t.is(copy.length, joiner.bee.core.length, 'at the head the joiner serves, not the stale one')
  t.is(copy.contiguous, copy.length, 'and whole')
})

test('a joiner that never pairs ends the capture at its budget', async (t) => {
  await freshPeer(t)
  const joiner = await joinerWithRecord(t)
  const socket = await joinerSocket(t, joiner, null)
  const t0 = Date.now()
  t.absent(await captureJoinerMembership(joiner.key, S, { timeoutMs: scaled(1500), socket }), 'nothing is captured')
  const dt = Date.now() - t0
  t.ok(dt < scaled(3000), 'inside the budget (' + dt + 'ms)')
})

test('a joiner whose socket closes ends the capture at once', async (t) => {
  await freshPeer(t)
  const joiner = await joinerWithRecord(t)
  const socket = await joinerSocket(t, joiner, null)
  setTimeout(() => socket.destroy(), 100)
  const t0 = Date.now()
  t.absent(await captureJoinerMembership(joiner.key, S, { timeoutMs: scaled(10000), socket }), 'nothing is captured')
  const dt = Date.now() - t0
  t.ok(dt < scaled(2000), 'well before the budget (' + dt + 'ms)')
})

test('without a delivered grant the capture does not wait for anyone', async (t) => {
  await freshPeer(t)
  const t0 = Date.now()
  t.absent(await captureJoinerMembership('ab'.repeat(32), S, { timeoutMs: scaled(5000) }), 'nothing is captured')
  const dt = Date.now() - t0
  t.ok(dt < scaled(1500), 'inside the head wait (' + dt + 'ms)')
})
