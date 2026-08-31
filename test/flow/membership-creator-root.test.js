import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { rawPeer } from '../helpers/raw-peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { encodeInvite, decodeInvite } from '../../src/shared/invite-envelope.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const hex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
// Identity mode + membership approval + binding ENFORCED — MIR-26 enforcement shares the
// MIR-03 saturation gate, so the root assertion is only authoritative once binding is on.
const bindFlags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })

const spaceOf = async (peer, spaceId) => (await peer.request('spaces:list')).find((s) => s.spaceId === spaceId)
const memberKeys = async (peer, spaceId) => new Set(((await spaceOf(peer, spaceId))?.members || []).map((m) => m.publicKey))

// The headline attack: an invite for A's REAL topic but with a forged creator (c = mKey).
// The victim pins mKey provisionally, but the authenticated grant from the real member
// corrects it — the forger never becomes the root, so it can mint no members on the victim.
test('REGRESSION (MIR-26: a forged-creator invite does NOT make the forger the root)', { timeout: 220000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })

  const space = await A.request('space:create', { name: 'Secret' })
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey
  const topic = decodeInvite(await A.request('space:invite', { spaceId: space.spaceId })).topic

  // The attacker relays A's real topic but swaps the creator field to its own fabricated key.
  const mKey = hex()
  const forged = encodeInvite({ topic, name: 'Secret', owner: aKey, ownerName: 'Alice', creator: mKey, schemaVersion: 2 })

  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId && m.publicKey === bKey)
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === space.spaceId)
  await B.request('space:join', { inviteCode: forged })

  const bPending = await spaceOf(B, space.spaceId)
  t.is(bPending.status, 'pending', 'B starts pending')
  t.is(bPending.creatorKey, mKey, 'B provisionally pinned the forged creator from the invite')
  t.is(bPending.creatorUnverified, true, 'but only provisionally')

  await aGotRequest
  await A.request('space:approve-member', { spaceId: space.spaceId, publicKey: bKey })
  await bGranted

  await B.until('spaces:list', {}, (list) => list.find((s) => s.spaceId === space.spaceId)?.creatorKey === aKey,
    { ms: 30000, every: 500 })
  const bSpace = await spaceOf(B, space.spaceId)
  t.is(bSpace.creatorKey, aKey, 'the authenticated grant corrected the root to the real creator')
  t.is(bSpace.creatorUnverified, false, 'and cleared the provisional flag')

  const bMembers = await memberKeys(B, space.spaceId)
  t.ok(bMembers.has(aKey), 'B sees the real creator A as a member')
  t.absent(bMembers.has(mKey), 'the forger M is NOT a member on B')
})

// Two honest peers, each granted by the real creator, pin the SAME root — so their member
// folds agree. (Pre-MIR-26 a stray forged invite could have left them rooted differently.)
test('REGRESSION (MIR-26: two honest peers never fork their root)', { timeout: 260000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const C = await launchPeer(t, { bootstrap, displayName: 'Carol', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })

  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey
  const cKey = (await C.request('profile:get')).publicKey

  const inviteC = await A.request('space:invite', { spaceId })
  const aGotC = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === cKey)
  const cGranted = C.waitFor('event:membership-granted', (m) => m.spaceId === spaceId)
  await C.request('space:join', { inviteCode: inviteC })
  await aGotC
  await A.request('space:approve-member', { spaceId, publicKey: cKey })
  await cGranted

  await C.until('spaces:list', {}, (list) => list.find((s) => s.spaceId === spaceId)?.creatorKey === aKey,
    { ms: 30000, every: 500 })
  t.is((await spaceOf(B, spaceId)).creatorKey, aKey, 'B rooted at the real creator')
  t.is((await spaceOf(C, spaceId)).creatorKey, aKey, 'C rooted at the SAME real creator')
})

// An unbound membership:grant (no valid MIR-03 binding) cannot pin a root or materialize the
// space under enforcement — so a topic-squatter that races a grant is refused, not trusted.
test('REGRESSION (MIR-26: an unbound grant is refused under enforcement)', { timeout: 240000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })

  const topic = hex()
  const mKey = hex()
  const forged = encodeInvite({ topic, creator: mKey, schemaVersion: 2 })
  await B.request('space:join', { inviteCode: forged })
  const spaceId = topic.slice(0, 16)
  t.is((await spaceOf(B, spaceId)).status, 'pending', 'B is pending after joining')

  const atk = await rawPeer(t, { bootstrap, topicHex: topic })
  await atk.waitConnected()
  // A grant with a well-formed SCK and creator but NO identity binding for any member.
  atk.send({ type: 'membership:grant', spaceTopic: topic, sck: hex(), creator: mKey })

  await new Promise((r) => setTimeout(r, 4000))
  t.is((await spaceOf(B, spaceId)).status, 'pending', 'B did not materialize from the unbound grant')
  t.ok(B.readStderr().includes('rejected membership:grant'), 'B logged the grant rejection')
})
