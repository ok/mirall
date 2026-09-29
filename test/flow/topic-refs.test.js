import test from 'brittle'
import crypto from 'crypto'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpaceWithApproval } from '../helpers/peer.js'
import { rawPeer } from '../helpers/raw-peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { waitFor } from '../helpers/poll.js'
import { decodeInvite } from '../../src/shared/contract/invite-envelope.js'
import { deriveTopicRef } from '../../src/shared/network/handshake-guard.js'
import { boundSender } from '../helpers/identity-binding.js'
import hcrypto from 'hypercore-crypto'

const kekHex = () => crypto.randomBytes(32).toString('hex')
const hex = () => crypto.randomBytes(32).toString('hex')
const idStore = (t) => path.join(mkTmpDir(t), 'app-storage')
const bindFlags = () => ({ identityKEK: kekHex(), handshakeIdentityBindingEnabled: true })

async function topicOf(peer, spaceId) {
  return decodeInvite(await peer.request('space:invite', { spaceId })).topic
}

test('REGRESSION (MIR-42: a socket that knows one topic receives no other space topic)', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const known = await A.request('space:create', { name: 'Known' })
  const hidden = await A.request('space:create', { name: 'Hidden' })
  const knownTopic = await topicOf(A, known.spaceId)
  const hiddenTopic = await topicOf(A, hidden.spaceId)

  const atk = await rawPeer(t, { bootstrap, topicHex: knownTopic })
  await atk.waitConnected()
  await waitFor(() => atk.frames.filter((m) => m.type === 'handshake').length >= 2, 20000, { label: 'one handshake per space' })
  const carrying = (topic) => atk.frames.filter((m) => JSON.stringify(m).includes(topic))
  t.comment(`received ${atk.frames.length} frame(s): ${atk.frames.map((m) => m.type + (m.spaceTopic ? ' spaceTopic' : '') + (m.topicRef ? ' topicRef' : '')).join(', ')}`)

  t.alike(carrying(hiddenTopic), [], 'no frame carries the hidden space topic')
  t.alike(carrying(knownTopic), [], 'nor the known one, which this socket never sent')
  const ref = (topic) => deriveTopicRef(topic, atk.remotePublicKey())
  t.ok(atk.frames.some((m) => m.topicRef === ref(knownTopic)), 'the known space is named by the sender-bound ref')

  atk.send({ type: 'handshake', profileKey: hex(), displayName: 'Old', spaceTopic: knownTopic })
  await atk.waitFrame((m) => m.type === 'handshake' && m.spaceTopic === knownTopic, scaled(20000))
  t.alike(carrying(hiddenTopic), [], 'answering a bearer-form peer in its form discloses no other topic')
})

test('a peer on the bearer-topic wire and one on refs admit each other both ways', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const fresh = await launchPeer(t, { bootstrap, displayName: 'New', storage: idStore(t), downloads: mkTmpDir(t) })
  // The re-announce tick is off on the old side, so the second leg can only converge through the
  // unheld-topic memory: its handshake for the new space reaches `fresh` before `fresh` holds it.
  const old = await launchPeer(t, { bootstrap, displayName: 'Old', storage: idStore(t), downloads: mkTmpDir(t), flags: { testLegacyTopicWire: true, convergenceTickMs: 0 } })

  const byNew = await connectInSpaceWithApproval(t, fresh, old, 'Created by new')
  const byOld = await connectInSpaceWithApproval(t, old, fresh, 'Created by old')
  t.ok(byNew && byOld, 'both spaces admitted across the wire versions')
})

const enforced = () => ({ ...bindFlags(), topicRefsEnforced: true })
const settle = () => new Promise((r) => setTimeout(r, scaled(3000)))

async function memberKeys(peer, spaceId) {
  const s = (await peer.request('spaces:list')).find((x) => x.spaceId === spaceId)
  return new Set((s?.members || []).map((m) => m.publicKey))
}

// A raw peer with a bound identity of its own: the binding is over its Noise key, so a frame it
// sends passes the identity gate and only the way it names the space decides.
async function boundRawPeer(t, bootstrap, topicHex) {
  const noise = hcrypto.keyPair()
  const me = boundSender({ noise })
  const atk = await rawPeer(t, { bootstrap, topicHex, keyPair: noise })
  await atk.waitConnected()
  const ref = (topic) => deriveTopicRef(topic, noise.publicKey)
  return { atk, me, ref }
}

test('REGRESSION (MIR-42: an enforced node answered the bearer form)', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: enforced() })
  const { spaceId } = await A.request('space:create', { name: 'Enforced' })
  const topic = await topicOf(A, spaceId)
  const { atk, me, ref } = await boundRawPeer(t, bootstrap, topic)

  const request = { type: 'membership:request', displayName: 'Old', inviteId: null, ...me.fields }
  const bearerKnock = A.waitFor('event:member-join-request', (m) => m.publicKey === me.profileKey, 8000)
  atk.send({ ...request, spaceTopic: topic })
  await t.exception(bearerKnock, 'a bearer-form request raises no join request')
  t.comment(`received ${atk.frames.length} frame(s): ${atk.frames.map((m) => m.type).join(', ')}`)
  t.absent(atk.frames.some((m) => 'spaceTopic' in m), 'and is not answered in the bearer form')
  t.absent((await memberKeys(A, spaceId)).has(me.profileKey), 'nor admitted')

  const refKnock = A.waitFor('event:member-join-request', (m) => m.publicKey === me.profileKey, 20000)
  atk.send({ ...request, topicRef: ref(topic) })
  await refKnock
  t.pass('the same request named by reference raises one')
})

test('REGRESSION (MIR-42: a socket that knows one space was sent every space\'s identity)', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: enforced() })
  const known = await A.request('space:create', { name: 'Known' })
  const hidden = await A.request('space:create', { name: 'Hidden' })
  const knownTopic = await topicOf(A, known.spaceId)
  const hiddenTopic = await topicOf(A, hidden.spaceId)
  const { atk, ref } = await boundRawPeer(t, bootstrap, knownTopic)

  await waitFor(() => atk.frames.filter((m) => m.type === 'space-ref' || m.type === 'handshake').length >= 2, 20000, { label: 'one frame per space' })
  await settle()
  const ours = (topic) => deriveTopicRef(topic, atk.remotePublicKey())
  const payload = (m) => 'driveKey' in m || 'looseCatalogKey' in m || 'looseCatalogKeyEnc' in m || 'creator' in m
  t.comment(`before proof: ${atk.frames.map((m) => m.type).join(', ')}`)
  t.absent(atk.frames.some((m) => m.type === 'handshake'), 'no identity frame before the socket names a space')
  t.absent(atk.frames.some(payload), 'no participation id, catalog key or creator root')
  t.is(atk.frames.filter((m) => m.type === 'space-ref').length, 2, 'one space-ref per space instead')

  atk.send({ type: 'space-ref', topicRef: ref(knownTopic) })
  const hello = await atk.waitFrame((m) => m.type === 'handshake', scaled(20000))
  t.is(hello.topicRef, ours(knownTopic), 'the proven space\'s identity frame follows the proof')
  t.ok(typeof hello.driveKey === 'string', 'with its participation id')
  await settle()
  t.absent(atk.frames.some((m) => m.type === 'handshake' && m.topicRef === ours(hiddenTopic)), 'the unproven space stays hidden')

  await A.request('space:leave', { spaceId: hidden.spaceId })
  await settle()
  t.absent(atk.frames.some((m) => m.type === 'leave'), 'leaving the unproven space tells this socket nothing')
})

test('two enforced peers admit each other both ways, including a space joined on the open socket', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: idStore(t), downloads: mkTmpDir(t), flags: enforced() })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', storage: idStore(t), downloads: mkTmpDir(t), flags: enforced() })
  const byA = await connectInSpaceWithApproval(t, A, B, 'By A')
  const byB = await connectInSpaceWithApproval(t, B, A, 'By B')
  t.ok(byA && byB, 'both spaces admitted')
})

test('an enforced peer and a flag-off peer admit each other both ways', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const on = await launchPeer(t, { bootstrap, displayName: 'On', storage: idStore(t), downloads: mkTmpDir(t), flags: enforced() })
  const off = await launchPeer(t, { bootstrap, displayName: 'Off', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const byOn = await connectInSpaceWithApproval(t, on, off, 'By on')
  const byOff = await connectInSpaceWithApproval(t, off, on, 'By off')
  t.ok(byOn && byOff, 'both spaces admitted across the flag')
})

test('a leave by reference drops the leaver on a flag-off co-member', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const on = await launchPeer(t, { bootstrap, displayName: 'On', storage: idStore(t), downloads: mkTmpDir(t), flags: enforced() })
  const off = await launchPeer(t, { bootstrap, displayName: 'Off', storage: idStore(t), downloads: mkTmpDir(t), flags: bindFlags() })
  const spaceId = await connectInSpaceWithApproval(t, off, on, 'Left by on')
  const onKey = (await on.request('profile:get')).personKey

  await on.request('space:leave', { spaceId })
  // member.left is written only where a leave frame is applied, never on a disconnect.
  await off.until('audit:list', { limit: 200 }, (p) => p.entries.some((e) => e.kind === 'member.left'), { ms: 30000 })
  t.pass('the flag-off member applied the leave named by reference')
  await waitFor(async () => !(await memberKeys(off, spaceId)).has(onKey), 20000, { label: 'the leaver drops off the roster' })
  t.pass('and dropped the leaver')
})

test('an enforced peer and a bearer-wire peer do not admit each other', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const on = await launchPeer(t, { bootstrap, displayName: 'On', storage: idStore(t), downloads: mkTmpDir(t), flags: enforced() })
  const old = await launchPeer(t, { bootstrap, displayName: 'Old', storage: idStore(t), downloads: mkTmpDir(t), flags: { testLegacyTopicWire: true } })
  const space = await on.request('space:create', { name: 'Cut off' })
  const inviteCode = await on.request('space:invite', { spaceId: space.spaceId })
  const knock = on.waitFor('event:member-join-request', (m) => m.spaceId === space.spaceId, 20000)
  await old.request('space:join', { inviteCode })
  await t.exception(knock, 'the bearer-wire joiner never reaches the enforced member')
})
