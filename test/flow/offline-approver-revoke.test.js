import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// REGRESSION (G6): an approver OFFLINE at leave time never receives the leave frame — the only
// place the revoke used to run. Its grow-only approved/<S>/<leaver> vouch survived, so when the
// departed member later re-asserted membership it was silently re-admitted with no fresh
// approval. Now the returned approver observes the leaver's durable `del member/<S>` via
// replication (re-hosted by the online co-member), revokes, and a rejoin must go through the
// normal pending-request flow.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const settle = (ms) => new Promise((r) => setTimeout(r, ms))
const hasMember = (l, spaceId, key) =>
  ((l.find((s) => s.spaceId === spaceId)?.members) || []).some((m) => m.publicKey === key)
const memberKeys = async (peer, spaceId) =>
  new Set(((await peer.request('spaces:list')).find((x) => x.spaceId === spaceId)?.members || []).map((m) => m.publicKey))

test('REGRESSION (G6): an approver offline at leave time revokes on return; rejoin needs fresh approval', { timeout: 300000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const flags = () => ({ identityKEK: kekHex(), membershipApprovalEnabled: true, handshakeIdentityBindingEnabled: true })
  // A (the creator/approver) is relaunched, so its KEK + storage stay fixed across boots.
  const aStorage = idStore(t)
  const aDownloads = mkTmpDir(t)
  const aBoot = flags()
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStorage, downloads: aDownloads, flags: aBoot })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey

  const space = await A.request('space:create', { name: 'Trio' })
  const spaceId = space.spaceId
  const invite = await A.request('space:invite', { spaceId })

  const aGotB = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey, 120000)
  await B.request('space:join', { inviteCode: invite })
  await aGotB
  const aGotC = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === cKey, 120000)
  await C.request('space:join', { inviteCode: invite })
  await aGotC

  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await bGranted
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 120000)
  await A.request('space:approve-member', { spaceId, publicKey: cKey })
  await cGranted

  await A.until('spaces:list', {}, (l) => hasMember(l, spaceId, bKey) && hasMember(l, spaceId, cKey), { ms: 60000, every: 1000 })
  await C.until('spaces:list', {}, (l) => hasMember(l, spaceId, bKey), { ms: 60000, every: 1000 })
  await B.until('spaces:list', {}, (l) => hasMember(l, spaceId, cKey), { ms: 60000, every: 1000 })

  // A goes offline BEFORE the leave — it must never see the frame.
  const aPid = A.sidecar?._process?.pid
  A.kill()
  if (aPid) await waitForWorkerExit(aPid, 8000)

  // B leaves cleanly. C's roster prune comes from the FRAME (handleLeaveFrame), not from a fold
  // read — so the until() below does NOT prove B's del block reached C's store. Once B (off the
  // topic after its teardown) disconnects, C is A's only source for the del, so hold a blind
  // replication window for C's live follow to pull it while B is still connected.
  await B.request('space:leave', { spaceId })
  await C.until('spaces:list', {}, (l) => !hasMember(l, spaceId, bKey), { ms: 60000, every: 1000 })
  await settle(2000)

  // A returns and must converge without ever having seen the frame: B out (observed via the
  // replicated del, served by C — B is not in the topic anymore), C still in.
  const A2 = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStorage, downloads: aDownloads, flags: aBoot })
  await A2.until('spaces:list', {}, (l) => {
    const s = l.find((x) => x.spaceId === spaceId)
    return !!s && !hasMember(l, spaceId, bKey) && hasMember(l, spaceId, cKey)
  }, { ms: 120000, every: 1000 })
  t.pass('returned approver dropped the leaver it never got a frame from')

  // The G6 payoff: B's rejoin is NOT silently re-admitted off A's old vouch — it surfaces as a
  // pending request needing fresh approval. Pre-fix, the surviving approved/<S>/<B> record
  // re-admitted B straight into the roster, no request.
  const a2GotReq = A2.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey, 120000)
  const invite2 = await C.request('space:invite', { spaceId })
  await B.request('space:join', { inviteCode: invite2 })
  await a2GotReq
  t.pass('rejoin surfaces as a pending request on the returned approver')
  await settle(5000)
  t.absent((await memberKeys(A2, spaceId)).has(bKey), 'no silent re-admit: the leaver is not a member until freshly approved')
})
