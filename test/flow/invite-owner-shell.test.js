import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import b4a from 'b4a'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { rawPeer } from '../helpers/raw-peer.js'
import { boundSender } from '../helpers/identity-binding.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { until } from '../helpers/poll.js'
import { encodeInvite, decodeInvite } from '../../src/shared/contract/invite-envelope.js'
import { sealSck } from '../../src/shared/spaces/sck-seal.js'
import { deriveTopicRef } from '../../src/shared/network/handshake-guard.js'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const hex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const bindFlags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })
const spaceOf = async (peer, spaceId) => (await peer.request('spaces:list')).find((s) => s.spaceId === spaceId)
const settles = (promise) => promise.then(() => true, () => false)

// A re-encoded invite names the forger as the inviter. The joiner shows the forger as an unverified
// inviter while pending, is approved by the real creator, and from then on the forger's own bound
// knock is an ordinary join request: no key, and no roster row after the first settled fold.
test('REGRESSION (MIR-44: a re-encoded invite owner is re-granted the space key as a shell member)', { timeout: scaled(240000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const { spaceId } = await A.request('space:create', { name: 'Secret' })
  const real = decodeInvite(await A.request('space:invite', { spaceId }))
  const bKey = (await B.request('profile:get')).personKey

  const atk = await rawPeer(t, { bootstrap, topicHex: real.topic })
  const mallory = boundSender({ noise: atk.keyPair })
  const forged = encodeInvite({ ...real, owner: mallory.profileKey, ownerName: 'Mallory' })

  const aGotRequest = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey, 60000)
  const bGranted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 60000)
  await B.request('space:join', { inviteCode: forged })
  const seeded = (await spaceOf(B, spaceId)).members.find((m) => m.publicKey === mallory.profileKey)
  t.comment('observed seed: ' + JSON.stringify(seeded))
  t.ok(seeded?.unverified, 'pending B shows the forger as an unverified inviter')

  await aGotRequest
  await A.request('space:approve-member', { spaceId, publicKey: bKey })
  await bGranted

  await atk.waitConnections(2)
  const bSawKnock = settles(B.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === mallory.profileKey, 30000))
  const gotGrant = settles(atk.waitFrame((m) => m.type === 'membership:grant', scaled(15000)))
  atk.send({ type: 'membership:request', displayName: 'Mallory', spaceTopic: real.topic, inviteId: null, ...mallory.fields })

  const [knocked, granted] = await Promise.all([bSawKnock, gotGrant])
  t.comment('observed: B raised a join request=' + knocked + ', the forger got a grant=' + granted)
  t.ok(knocked, 'B took the bound frame as a knock to review')
  t.absent(granted, 'the forger received no space key')
  await B.until('space:members', { spaceId }, (roster) => Array.isArray(roster) && !roster.some((m) => m.publicKey === mallory.profileKey), { ms: 60000, every: 1000 })
  t.pass('the shell is gone from B\'s roster after the first settled fold')
  const pending = await B.request('space:pending-requests', { spaceId })
  t.ok(pending.some((r) => r.publicKey === mallory.profileKey), 'the forger\'s knock is an open request B can deny')
})

// Re-pasting a link into a space we already belong to must add nobody: the owner it names is the
// link's claim, and we are not waiting on anyone.
test('REGRESSION (MIR-44: re-pasting a forged invite adds its owner to a joined space)', { timeout: scaled(220000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const spaceId = await connectInSpaceWithApproval(t, A, B)
  const real = decodeInvite(await A.request('space:invite', { spaceId }))
  const M = hex()

  await B.request('space:join', { inviteCode: encodeInvite({ ...real, owner: M, ownerName: 'Mallory' }) })
  const roster = (await spaceOf(B, spaceId)).members
  t.comment('observed roster: ' + JSON.stringify(roster.map((m) => [m.displayName, !!m.unverified])))
  t.absent(roster.some((m) => m.publicKey === M), 'the forged owner is not on the roster')
  t.is((await spaceOf(B, spaceId)).status, 'approved', 'B is still a member')
})

// While pending, a grant is honoured from the invite's inviter or the creator it names; a stranger
// with a valid binding of its own is not either, and nothing roots it in the member set.
test('REGRESSION (MIR-26: a bound grant from a stranger is honoured while pending)', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const topic = hex()
  const atk = await rawPeer(t, { bootstrap, topicHex: topic })
  const creator = hex()
  const owner = boundSender({ noise: atk.keyPair })
  const squatter = boundSender({ noise: atk.keyPair })
  const spaceId = topic.slice(0, 16)

  await B.request('space:join', { inviteCode: encodeInvite({ topic, creator, owner: owner.profileKey, ownerName: 'Olga', schemaVersion: 2 }) })
  await atk.waitConnected()
  const request = await atk.waitFrame((m) => m.type === 'membership:request' && m.topicRef === deriveTopicRef(topic, atk.remotePublicKey()), scaled(20000))
  const seal = () => b4a.toString(sealSck(crypto.randomBytes(32), b4a.from(request.signerKey, 'hex')), 'hex')
  const grantFrom = ({ fields: { profileKey, ...binding } }) => ({ type: 'membership:grant', spaceTopic: topic, sckSealed: seal(), creator, granterKey: profileKey, ...binding })

  atk.send(grantFrom(squatter))
  const refused = await until(() => B.readStderr().includes('granter is not the inviter'), 30000, { interval: 250 })
  const status = (await spaceOf(B, spaceId)).status
  t.comment('observed: status=' + status + ' refusal logged=' + refused)
  t.is(status, 'pending', 'B did not materialize from the stranger\'s grant')
  t.ok(refused, 'B logged the refusal')
  // Vetting the squatter lent it roster cores, a loan that ends by closing the socket.
  t.ok(await until(() => atk.closedSockets() > 0, 15000, { interval: 100 }), 'B closed the squatter\'s socket')
  await atk.waitConnected()

  const granted = B.waitFor('event:membership-granted', (m) => m.spaceId === spaceId, 30000)
  atk.send(grantFrom(owner))
  await granted
  t.is((await spaceOf(B, spaceId)).status, 'approved', 'the inviter\'s grant is honoured')
})
