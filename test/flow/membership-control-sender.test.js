import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import b4a from 'b4a'
import Corestore from 'corestore'
import Hyperbee from 'hyperbee'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval, waitForWorkerExit } from '../helpers/peer.js'
import { rawPeer } from '../helpers/raw-peer.js'
import { boundSender } from '../helpers/identity-binding.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { until } from '../helpers/poll.js'
import { decodeInvite, encodeInvite } from '../../src/shared/contract/invite-envelope.js'
import { deriveTopicRef } from '../../src/shared/network/handshake-guard.js'
import { sealSck } from '../../src/shared/spaces/sck-seal.js'

const hex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const enforcedFlags = () => ({ identityKEK: hex(), handshakeIdentityBindingEnabled: true, membershipControlBindingEnforced: true })
const peer = (t, bootstrap, displayName, flags = enforcedFlags()) =>
  launchPeer(t, { bootstrap, displayName, storage: idStore(t), downloads: mkTmpDir(t), flags })

const lists = async (p, spaceId, key) => (await p.request('space:pending-requests', { spaceId })).some((r) => r.publicKey === key)
const spaceOf = async (p, spaceId) => (await p.request('spaces:list')).find((s) => s.spaceId === spaceId)

test('REGRESSION (MIR-48: a stranger\'s cancel tombstoned a pending joiner)', { timeout: scaled(220000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice')
  const { spaceId } = await A.request('space:create', { name: 'Topic only' })
  const topic = decodeInvite(await A.request('space:invite', { spaceId })).topic

  const atk = await rawPeer(t, { bootstrap, topicHex: topic })
  await atk.waitConnected()
  const topicRef = deriveTopicRef(topic, atk.keyPair.publicKey)
  const joiner = boundSender({ noise: atk.keyPair })
  const stranger = boundSender({ noise: atk.keyPair })
  const knock = () => atk.send({ type: 'membership:request', displayName: 'Jo', topicRef, inviteId: null, ...joiner.fields })
  const cancel = (fields) => ({ type: 'membership:cancel', topicRef, joinerKey: joiner.profileKey, ...fields })

  const knocked = A.waitFor('event:member-join-request', (m) => m.publicKey === joiner.profileKey)
  knock()
  await knocked
  t.ok(await lists(A, spaceId, joiner.profileKey), 'A shows the joiner')

  atk.send(cancel(stranger.fields))
  atk.send(cancel({}))
  await t.exception(atk.waitFrame((m) => m.type === 'membership:cancel-ack', scaled(8000)), /no matching frame/, 'neither cancel is acked')
  t.ok(await lists(A, spaceId, joiner.profileKey), 'the banner stays')

  knock()
  await t.exception(atk.waitFrame((m) => m.type === 'membership:deny', scaled(8000)), /no matching frame/, 'the next knock is reviewed, not answered with a replayed deny')
  t.ok(await lists(A, spaceId, joiner.profileKey), 'and still listed')

  atk.send(cancel(joiner.fields))
  const ack = await atk.waitFrame((m) => m.type === 'membership:cancel-ack', scaled(15000))
  t.is(ack.applied, true, 'the joiner\'s own cancel is applied and acked')
  t.ok(await until(async () => !(await lists(A, spaceId, joiner.profileKey)), 15000, { interval: 250 }), 'and the banner clears')
})

// A pending joiner B on an invite naming an inviter and a creator; the raw peer holds the inviter's
// identity and a stranger's on the same socket.
async function pendingJoiner(t, flags, { topic = hex(), creator = hex(), store = null } = {}) {
  const bootstrap = await localTestnet(t)
  const B = await peer(t, bootstrap, 'Bob', flags)
  const atk = await rawPeer(t, { bootstrap, topicHex: topic, store })
  const owner = boundSender({ noise: atk.keyPair })
  const stranger = boundSender({ noise: atk.keyPair })
  const spaceId = topic.slice(0, 16)
  await B.request('space:join', { inviteCode: encodeInvite({ topic, creator, owner: owner.profileKey, ownerName: 'Olga', schemaVersion: 2 }) })
  await atk.waitConnected()
  const request = await atk.waitFrame((m) => m.type === 'membership:request' && m.topicRef === deriveTopicRef(topic, atk.remotePublicKey()), scaled(20000))
  const topicRef = deriveTopicRef(topic, atk.keyPair.publicKey)
  const deny = (fields) => atk.send({ type: 'membership:deny', topicRef, ...fields })
  const sckSealed = () => b4a.toString(sealSck(crypto.randomBytes(32), b4a.from(request.signerKey, 'hex')), 'hex')
  const grant = ({ profileKey, ...binding }) => atk.send({ type: 'membership:grant', topicRef, sckSealed: sckSealed(), creator, granterKey: profileKey, ...binding })
  return { B, atk, spaceId, owner, stranger, deny, grant, joinerKey: request.profileKey }
}

// A creator roster the raw peer serves: it approves a key nobody serves, so the joiner's fold walk
// waits a full read budget on that key.
async function stalledRoster(store, spaceId) {
  const core = store.get({ name: 'creator' })
  await core.ready()
  const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await bee.put('caps/membership-manifest', true)
  await bee.put('member/' + spaceId, { active: true, ts: Date.now() })
  await bee.put('approved/' + spaceId + '/' + hex(), { ts: Date.now() })
  return b4a.toString(core.key, 'hex')
}

test('REGRESSION (MIR-48: vetting a stranger\'s deny served the joiner\'s own profile core to it)', { timeout: scaled(180000) }, async (t) => {
  const store = new Corestore(mkTmpDir(t))
  t.teardown(() => store.close())
  const topic = hex()
  const creator = await stalledRoster(store, topic.slice(0, 16))
  const { B, atk, spaceId, stranger, deny, joinerKey } = await pendingJoiner(t, enforcedFlags(), { topic, creator, store })

  const own = store.get({ key: b4a.from(joinerKey, 'hex') })
  await own.ready()
  const served = own.get(0, { timeout: scaled(30000) }).then(() => true, () => false)
  deny({ ...stranger.fields, rosterPath: [creator, joinerKey, stranger.profileKey] })
  t.ok(await until(() => B.readStderr().includes('rejected membership:deny'), 60000, { interval: 250 }), 'the deny and the chain it forged were vetted and refused')
  t.ok(await until(() => atk.closedSockets() > 0, 15000, { interval: 100 }), 'the walk ended by closing the stranger\'s socket')
  t.absent(await served, 'the stranger read no block of the joiner\'s profile core meanwhile')
  t.is((await spaceOf(B, spaceId))?.status, 'pending', 'B keeps its pending space')
})

test('REGRESSION (FIX-553: vetting a stranger\'s grant served the joiner\'s own profile core to it)', { timeout: scaled(180000) }, async (t) => {
  const store = new Corestore(mkTmpDir(t))
  t.teardown(() => store.close())
  const topic = hex()
  const creator = await stalledRoster(store, topic.slice(0, 16))
  const { B, atk, spaceId, stranger, grant, joinerKey } = await pendingJoiner(t, enforcedFlags(), { topic, creator, store })

  const own = store.get({ key: b4a.from(joinerKey, 'hex') })
  await own.ready()
  const served = own.get(0).then(() => true, () => false)
  grant(stranger.fields)
  t.ok(await until(() => B.readStderr().includes('granter is not the inviter'), 60000, { interval: 250 }), 'the grant was vetted against the stalled roster and refused')
  t.ok(await until(() => atk.closedSockets() > 0, 15000, { interval: 100 }), 'the walk ended by closing the stranger\'s socket')
  await own.close()
  const read = await served
  t.comment('observed: stranger read block 0 of the joiner\'s profile core = ' + read)
  t.absent(read, 'the stranger read no block of the joiner\'s profile core meanwhile')
  t.is((await spaceOf(B, spaceId))?.status, 'pending', 'B keeps its pending space')
})

test('REGRESSION (MIR-48: a stranger\'s deny discarded a pending joiner)', { timeout: scaled(180000) }, async (t) => {
  const { B, spaceId, owner, stranger, deny } = await pendingJoiner(t, enforcedFlags())
  const discarded = B.waitFor('event:membership-denied', (m) => m.spaceId === spaceId, 90000)
  let denied = false
  discarded.then(() => { denied = true }, () => {})

  deny(stranger.fields)
  deny({})
  const refused = await until(() => B.readStderr().split('rejected membership:deny').length > 2, 30000, { interval: 250 })
  t.ok(refused, 'B logged both refusals')
  t.is((await spaceOf(B, spaceId))?.status, 'pending', 'B keeps its pending space')
  t.absent(denied, 'and was not told it was denied')

  deny(owner.fields)
  await discarded
  t.absent(await spaceOf(B, spaceId), 'the inviter\'s deny discards the pending space')
})

test('a deny that names no sender is still honoured while enforcement is off', { timeout: scaled(180000) }, async (t) => {
  const { B, spaceId, deny } = await pendingJoiner(t, { identityKEK: hex(), handshakeIdentityBindingEnabled: true })
  const discarded = B.waitFor('event:membership-denied', (m) => m.spaceId === spaceId, 30000)
  deny({})
  await discarded
  t.absent(await spaceOf(B, spaceId), 'an older member\'s deny still reaches the joiner')
})

// Alice, the inviter and creator, is offline when Carol denies, so the only deny Bob can act on is
// Carol's.
async function coMemberDeny(t, flags) {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice', flags())
  const C = await peer(t, bootstrap, 'Carol', flags())
  const B = await peer(t, bootstrap, 'Bob', flags())
  const spaceId = await connectInSpaceWithApproval(t, A, C)
  const bKey = (await B.request('profile:get')).personKey

  const aSees = A.waitFor('event:member-join-request', (m) => m.spaceId === spaceId && m.publicKey === bKey, 120000)
  await B.request('space:join', { inviteCode: await A.request('space:invite', { spaceId }) })
  await aSees
  await C.until('space:pending-requests', { spaceId }, (r) => r.some((x) => x.publicKey === bKey), { ms: 60000 })

  const aPid = A.sidecar?._process?.pid
  A.kill()
  if (aPid) await waitForWorkerExit(aPid, 5000)

  const discarded = B.waitFor('event:membership-denied', (m) => m.spaceId === spaceId, 60000)
  t.alike(await C.request('space:deny-member', { spaceId, publicKey: bKey }), { outcome: 'denied' }, 'Carol denies')
  await discarded
  t.pass('Bob accepted a deny from a member that is neither the inviter nor the creator')
}

test('a co-member\'s deny discards the joiner while enforcement is off', { timeout: scaled(300000) }, async (t) => {
  await coMemberDeny(t, () => ({ identityKEK: hex(), handshakeIdentityBindingEnabled: true }))
})

test('REGRESSION (MIR-48: a co-member\'s deny was refused under enforcement)', { timeout: scaled(300000) }, async (t) => {
  await coMemberDeny(t, enforcedFlags)
})

// With the identity binding off, the wire accepts a profileKey in either case; approve and deny
// accept only the lowercase spelling, so a knock under any other spelling must never be listed.
test('REGRESSION (MIR-49: a knock under a non-canonical key is never listed)', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await peer(t, bootstrap, 'Alice', { identityKEK: hex(), handshakeIdentityBindingEnabled: false })
  const { spaceId } = await A.request('space:create', { name: 'Case' })
  const topic = decodeInvite(await A.request('space:invite', { spaceId })).topic

  const atk = await rawPeer(t, { bootstrap, topicHex: topic })
  await atk.waitConnected()
  const topicRef = deriveTopicRef(topic, atk.keyPair.publicKey)
  const joiner = boundSender({ noise: atk.keyPair })
  const upper = joiner.profileKey.toUpperCase()
  const knock = (profileKey) => atk.send({ type: 'membership:request', displayName: 'Jo', topicRef, inviteId: null, ...joiner.fields, profileKey })

  knock(upper)
  const knocked = A.waitFor('event:member-join-request', (m) => m.publicKey === joiner.profileKey)
  knock(joiner.profileKey)
  await knocked
  t.ok(await lists(A, spaceId, joiner.profileKey), 'the canonical knock on the same socket is listed')
  t.absent(await lists(A, spaceId, upper), 'the uppercase knock before it is not')
})
