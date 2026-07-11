import test from 'brittle'
import path from 'path'
import crypto from 'crypto'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, waitForWorkerExit } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const flagsFor = (kek) => ({ identityKEK: kek, membershipApprovalEnabled: true })
const showsB = (reqs, bKey) => Array.isArray(reqs) && reqs.some((r) => r.publicKey === bKey)

// A withdrawing pending joiner must reach the member showing its request; that member writes a
// durable denied tombstone. The member's banner must clear and STAY cleared (survive its restart).
test('a withdrawn pending request clears on the member and stays cleared', { timeout: 200000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aStore = idStore(t)
  const aKek = kekHex()   // stable across Alice's restart so her identity re-unlocks
  let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: mkTmpDir(t), flags: flagsFor(aKek) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flagsFor(kekHex()) })
  const space = await A.request('space:create', { name: 'Secret' })
  const invite = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey

  const aReq = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq
  t.ok(showsB(await A.request('space:pending-requests', { spaceId: space.spaceId }), bKey), 'A shows B as a pending request')

  await B.request('space:leave', { spaceId: space.spaceId })
  await A.until('space:pending-requests', { spaceId: space.spaceId }, (reqs) => !showsB(reqs, bKey), { ms: 30000, every: 500 })
  t.absent(showsB(await A.request('space:pending-requests', { spaceId: space.spaceId }), bKey), 'the withdrawn request is gone')

  // Durable: A restarts (same storage + KEK) and does NOT resurrect the withdrawn request.
  const aPid = A.sidecar?._process?.pid
  A.kill()
  if (aPid) await waitForWorkerExit(aPid, 5000)
  A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: mkTmpDir(t), flags: flagsFor(aKek) })
  await new Promise((r) => setTimeout(r, scaled(3000)))
  t.absent(showsB(await A.request('space:pending-requests', { spaceId: space.spaceId }), bKey), "the withdrawal survived A's restart")
})

// REGRESSION: a single fire-and-forget cancel used to strand the banner if the member missed it.
// The pending-cancel replay re-announces on every connection until acked, so a member OFFLINE at
// withdrawal time still converges on the withdrawal when it returns.
test('a withdrawal reaches a member offline at withdrawal time (pending-cancel replay)', { timeout: 200000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aStore = idStore(t)
  const aKek = kekHex()
  let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: mkTmpDir(t), flags: flagsFor(aKek) })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: flagsFor(kekHex()) })
  const space = await A.request('space:create', { name: 'Secret' })
  const invite = await A.request('space:invite', { spaceId: space.spaceId })
  const bKey = (await B.request('profile:get')).publicKey

  const aReq = A.waitFor('event:member-join-request', (m) => m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aReq
  t.ok(showsB(await A.request('space:pending-requests', { spaceId: space.spaceId }), bKey), 'A shows B pending')

  // A is offline when B withdraws — the immediate cancel frame can't reach it.
  const aPid = A.sidecar?._process?.pid
  A.kill()
  if (aPid) await waitForWorkerExit(aPid, 5000)
  await B.request('space:leave', { spaceId: space.spaceId })

  // A returns; B's pending-cancel replay reaches it on the fresh connection and clears it durably.
  A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: mkTmpDir(t), flags: flagsFor(aKek) })
  await A.until('space:pending-requests', { spaceId: space.spaceId }, (reqs) => !showsB(reqs, bKey), { ms: 60000, every: 500 })
  t.absent(showsB(await A.request('space:pending-requests', { spaceId: space.spaceId }), bKey), 'the offline-at-withdrawal member converged via replay')
})
