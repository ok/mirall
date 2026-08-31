import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// REGRESSION (FIX-240): a member approved by a CO-MEMBER (not the creator) leaves; BOTH the creator
// and the approver must drop it. The leave frame is now identity-bound (accepted even if the
// per-socket auth index raced away during teardown), and the approver's revoke plus a durable local
// tombstone keep it dropped. Before the fix the leaver could linger with its stale driveKey.

const kekHex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const hasMember = (l, spaceId, key) =>
  new Set((l.find((s) => s.spaceId === spaceId)?.members || []).map((m) => m.publicKey)).has(key)
const memberKeys = async (peer, spaceId) =>
  new Set(((await peer.request('spaces:list')).find((x) => x.spaceId === spaceId)?.members || []).map((m) => m.publicKey))

test('FIX-240: a co-member-approved leaver is dropped by the creator and the approver', { timeout: 300000 }, async (t) => {
  const flags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })
  const bootstrap = await localTestnet(t)
  const mk = (name) => launchPeer(t, { bootstrap, displayName: name, storage: idStore(t), downloads: mkTmpDir(t), flags: flags() })
  const A = await mk('Alice'); const B = await mk('Bob'); const C = await mk('Carol')
  const bKey = (await B.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey

  const space = await A.request('space:create', { name: 'Trio' })
  const spaceId = space.spaceId
  const invite = await A.request('space:invite', { spaceId })

  const aGotB = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey)
  await B.request('space:join', { inviteCode: invite })
  await aGotB
  const aGotC = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === cKey)
  await C.request('space:join', { inviteCode: invite })
  await aGotC

  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await bGranted

  // B (a co-member) approves C — C is now approved by a member that is NOT the creator.
  await B.until('space:pending-requests', { spaceId }, (r) => r.some((x) => x.publicKey === cKey), { ms: 30000 })
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await B.request('space:approve-member', { spaceId, publicKey: cKey })
  await cGranted

  await A.until('spaces:list', {}, (l) => hasMember(l, spaceId, cKey), { ms: 30000 })
  await B.until('spaces:list', {}, (l) => hasMember(l, spaceId, cKey), { ms: 30000 })

  await C.request('space:leave', { spaceId })

  await A.until('spaces:list', {}, (l) => !hasMember(l, spaceId, cKey), { ms: 60000 })
  await B.until('spaces:list', {}, (l) => !hasMember(l, spaceId, cKey), { ms: 60000 })

  t.absent((await memberKeys(A, spaceId)).has(cKey), 'creator A dropped the co-member-approved leaver C')
  t.absent((await memberKeys(B, spaceId)).has(cKey), 'approver B dropped the leaver C')
})
