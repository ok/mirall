import test from 'brittle'
import fs from 'fs'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForCatalogEntry } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const v2flags = (extra = {}) => ({ identityKEK: kekHex(), membershipApprovalEnabled: true, ...extra })
// Fast re-announce for tests that exercise the convergence tick; production runs 15s/10s.
const fastTick = { convergenceTickMs: 300, announceBaseMs: 250, announceCapMs: 1000, announceMaxAttempts: 8 }

const persistedAs = (spaceId, key) => (list) => {
  const s = list.find((x) => x.spaceId === spaceId)
  return !!(s && (s.members || []).some((m) => m.publicKey === key && m.status !== 'pending'))
}

async function approveAndConverge (t, A, B, spaceId, requestPromise) {
  const req = await requestPromise
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await A.request('space:approve-member', { spaceId, publicKey: req.publicKey })
  await bGranted
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  await A.until('spaces:list', {}, persistedAs(spaceId, bKey), { ms: 60000, every: 1000 })
  await B.until('spaces:list', {}, persistedAs(spaceId, aKey), { ms: 60000, every: 1000 })
}

// The joiner belongs to several spaces the creator has never heard of. Its connection-open
// burst sends one identity frame per space, the shared space LAST (topics join in creation
// order) — on a single-lane rate limiter (burst 4, charged before topic matching) the
// creator silently dropped the one frame that mattered, the membership:request, and no
// banner ever appeared until a reconnect (the Egypt field failure). The two-lane limiter
// admits it: the five unmatched frames ride their own generous lane.
test('REGRESSION (FIX-1): join request survives a multi-space connection-open burst', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Creator', flags: v2flags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Joiner', flags: v2flags() })

  for (let i = 0; i < 5; i++) await B.request('space:create', { name: 'solo-' + i })
  const space = await A.request('space:create', { name: 'Shared' })
  const inviteCode = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey

  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey, 30000)
  await B.request('space:join', { inviteCode })
  await approveAndConverge(t, A, B, space.spaceId, aGotRequest)
  t.pass('banner appeared and membership converged despite 5 foreign-space frames ahead of the request')
})

// The creator drops the joiner's entire opening burst (deterministic lossy-link lever).
// Pre-approval there is NO fold/readmit backstop — the request was never recorded anywhere —
// so only the joiner's level-triggered re-announce can surface the banner. Red with the
// convergence tick disabled; green with it on.
test('REGRESSION (FIX-2): a dropped membership:request is re-announced until the banner appears', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Creator', flags: v2flags({ testDropIdentityFramesCount: 4 }) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Joiner', flags: v2flags(fastTick) })

  const space = await A.request('space:create', { name: 'Shared' })
  const inviteCode = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey

  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey, 45000)
  await B.request('space:join', { inviteCode })
  await approveAndConverge(t, A, B, space.spaceId, aGotRequest)
  t.pass('request heartbeat outlived the drop window and the flow completed')
})

// The creator admits the request but drops the joiner's post-grant handshake burst — the
// frame that fast-paths the joiner into the roster and draws the reciprocal that lets the
// joiner see the creator. The announce ledger re-sends it until the round trip settles;
// no restart of either peer. (Post-approval the fold+readmit path can also converge this
// state once records replicate — the deterministic pre-approval pin is FIX-2; this test
// covers the ledger's handshake kind end-to-end under drops.)
test('REGRESSION (FIX-3): joiner converges the creator although its post-grant handshakes were dropped', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Creator', flags: v2flags({ testDropIdentityFramesAfter: 1, testDropIdentityFramesCount: 3 }) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Joiner', flags: v2flags(fastTick) })

  const space = await A.request('space:create', { name: 'Shared' })
  const inviteCode = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey

  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey, 30000)
  await B.request('space:join', { inviteCode })
  await approveAndConverge(t, A, B, space.spaceId, aGotRequest)
  t.pass('dropped post-grant handshakes healed via re-announce + reciprocal, no restart')
})

// With the tick running hot, a full approve → share → download-visible flow stays green and
// both workers shut down cleanly (the teardown leak check enforces the timer lifecycle). A
// converged swarm must make the tick a no-op — this is the smoke for that steady state.
test('convergence tick smoke: hot tick does not disturb a healthy flow', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Creator', flags: v2flags(fastTick) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Joiner', flags: v2flags(fastTick) })

  const space = await A.request('space:create', { name: 'Shared' })
  const inviteCode = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey
  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey, 30000)
  await B.request('space:join', { inviteCode })
  await approveAndConverge(t, A, B, space.spaceId, aGotRequest)

  const src = path.join(mkTmpDir(t), 'photo.bin')
  const bytes = patternedBytes(64 * 1024, 7)
  fs.writeFileSync(src, bytes)
  await A.request('files:add', { spaceId: space.spaceId, filePath: src, fileName: 'photo.bin', fileSize: bytes.length })
  const entry = await waitForCatalogEntry(B, space.spaceId, '/photo.bin')
  t.is(entry.size, bytes.length, 'peer file visible with the tick running')
})
