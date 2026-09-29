import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { markOwnMembership, markApproval, hasOwnApproval } from '../../src/shared/spaces/profile.js'
import { upsertMember, mutateMembers, getSpace } from '../../src/shared/spaces/space.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { openMemberView, closeMemberView, isLeft, isApprovedJoiner } from '../../src/shared/spaces/member-registry.js'
import { loadLeftTombstones, persistLeftTombstone } from '../../src/shared/spaces/leave-records.js'
import { initLeaveProtocol, handleLeaveFrame, resetLeaveProtocol, handleLeaveAckFrame, registerPendingLeave, configurePendingLeaves, sendPendingLeaveFrames, hasPendingLeave } from '../../src/shared/network/leave-protocol.js'
import { connectedPeers, socketToPeers, socketMsgHandlers, spaceTopics, resetRegistries } from '../../src/shared/network/swarm-registries.js'
import { signNoiseBinding, leaveFrameBound, deriveTopicRef } from '../../src/shared/network/handshake-guard.js'
import { noteSpaceProven } from '../../src/shared/network/topic-refs.js'
import { PEER_FRAME } from '../../src/shared/contract/peer-frames.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }
const hex = () => b4a.toString(crypto.randomBytes(32), 'hex')

// The four collaborators swarm.js injects; the IPC emitter records what the handler announces.
function wire(t) {
  const emitted = []
  initLeaveProtocol({
    log: quiet,
    getRevokeServesHook: () => null,
    getSwarm: () => null,
    getIpc: () => ({ emit: (name, payload) => emitted.push({ name, payload }) }),
  })
  t.teardown(() => { resetLeaveProtocol(); resetRegistries() })
  return emitted
}

// A leave from `peer` over a fresh connection, bound the way getLocalBinding binds our own.
function boundLeave(peer, spaceId) {
  const noise = crypto.keyPair()
  const core = peer.bee.core
  const sent = []
  const socket = {}
  socketMsgHandlers.set(socket, { send: (s) => sent.push(JSON.parse(s)) })
  const msg = {
    type: PEER_FRAME.LEAVE,
    spaceId,
    profileKey: peer.key,
    ts: Date.now(),
    sig: signNoiseBinding(noise.publicKey, core.keyPair.secretKey),
    signerKey: b4a.toString(core.keyPair.publicKey, 'hex'),
    signerNs: b4a.toString(core.manifest.signers[0].namespace, 'hex'),
  }
  const acked = () => sent.some((f) => f.type === PEER_FRAME.LEAVE_ACK)
  return { socket, peerInfo: { publicKey: noise.publicKey }, msg, acked }
}

function withMemberCap(t, cap) {
  const prev = { ...getRuntimeConfig() }
  setRuntimeConfig({ ...prev, maxMembersPerSpace: cap })
  t.teardown(() => setRuntimeConfig(prev))
}

// A space where we vouch for member B, B is live and replicated, and the view is open.
async function spaceWithMember(t, name) {
  const { spaceId } = await createSpace(name)
  await markOwnMembership(spaceId)
  const B = await makePeer(t)
  await B.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await markApproval(spaceId, B.key)
  await upsertMember(spaceId, { publicKey: B.key })
  replicate(getStore(), B.store, t)
  return { spaceId, B }
}

test('REGRESSION (MIR-43: a bound non-member leave adopts, tombstones and acks nothing)', async (t) => {
  await freshPeer(t)
  const emitted = wire(t)
  const { spaceId } = await createSpace('MIR43-stranger')
  await markOwnMembership(spaceId)

  const atk = await makePeer(t)
  const X = await makePeer(t)
  await atk.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await atk.bee.put('approved/' + spaceId + '/' + X.key, { ts: 1 })
  replicate(getStore(), atk.store, t)
  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))

  const leave = boundLeave(atk, spaceId)
  t.ok(leaveFrameBound(leave.peerInfo, leave.msg), 'precondition: the stranger\'s key binding is valid on this connection')
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg)

  t.absent(await hasOwnApproval(spaceId, X.key), 'no approval authored for the stranger\'s vouchee')
  t.absent(isApprovedJoiner(spaceId, X.key), 'the fold does not approve the vouchee either')
  t.absent((await loadLeftTombstones(spaceId)).has(atk.key), 'no durable left/ tombstone')
  t.absent(isLeft(spaceId, atk.key), 'no in-memory tombstone')
  t.absent(leave.acked(), 'no leave-ack')
  t.absent(emitted.some((e) => e.name === 'event:member-left'), 'no member-left event')
})

// The inviter a bearer invite names is on the roster, flagged unverified. Holding it there must not
// let its leave frame make us author approvals for keys it vouched for.
test('REGRESSION (MIR-44: an unverified invite seed\'s leave frame was applied)', async (t) => {
  await freshPeer(t)
  const emitted = wire(t)
  const { spaceId } = await createSpace('MIR44-seed')
  await markOwnMembership(spaceId)

  const atk = await makePeer(t)
  const X = await makePeer(t)
  await atk.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await atk.bee.put('approved/' + spaceId + '/' + X.key, { ts: 1 })
  replicate(getStore(), atk.store, t)
  await mutateMembers(spaceId, () => [{ publicKey: atk.key, displayName: 'Mallory', avatar: null, unverified: true }])

  const leave = boundLeave(atk, spaceId)
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg)

  const adopted = await hasOwnApproval(spaceId, X.key)
  t.comment('observed: adopted=' + adopted + ' acked=' + leave.acked())
  t.absent(adopted, 'no approval authored for the seed\'s vouchee')
  t.absent(leave.acked(), 'no leave-ack')
  t.absent(emitted.some((e) => e.name === 'event:member-left'), 'no member-left event')
})

test('REGRESSION (MIR-43: a member\'s leave still adopts its vouchees, revokes, tombstones and acks)', async (t) => {
  await freshPeer(t)
  const emitted = wire(t)
  const { spaceId, B } = await spaceWithMember(t, 'MIR43-member')
  const C = await makePeer(t)
  await C.bee.put('member/' + spaceId, { active: true, ts: 1000 })
  await B.bee.put('approved/' + spaceId + '/' + C.key, { ts: 1 })
  replicate(getStore(), C.store, t)
  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))
  t.ok(await waitFor(() => isApprovedJoiner(spaceId, C.key), 8000), 'precondition: the fold authorizes C through B')

  const leave = boundLeave(B, spaceId)
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg)

  t.ok(await hasOwnApproval(spaceId, C.key), 'B\'s vouchee is adopted')
  t.absent(await hasOwnApproval(spaceId, B.key), 'our vouch for B is revoked')
  t.ok((await loadLeftTombstones(spaceId)).has(B.key), 'B is durably tombstoned')
  t.ok(leave.acked(), 'B is acked')
  t.ok(emitted.some((e) => e.name === 'event:member-left' && e.payload.publicKey === B.key), 'member-left is announced')

  const replay = boundLeave(B, spaceId)
  await handleLeaveFrame(replay.socket, replay.peerInfo, replay.msg)
  t.ok(replay.acked(), 'a replayed leave from a tombstoned leaver is acked again')
})

test('REGRESSION (MIR-43: the durable tombstone cap clears only tombstones the fold no longer authorizes)', async (t) => {
  await freshPeer(t)
  wire(t)
  withMemberCap(t, 2)
  const { spaceId, B } = await spaceWithMember(t, 'MIR43-cap')
  const held = hex()
  const inert = hex()
  await markApproval(spaceId, held)
  await persistLeftTombstone(spaceId, held, 1)
  await persistLeftTombstone(spaceId, inert, 1)
  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))
  t.ok(await waitFor(() => isApprovedJoiner(spaceId, held), 8000), 'precondition: the fold authorizes `held`')

  const leave = boundLeave(B, spaceId)
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg)

  const rows = await loadLeftTombstones(spaceId)
  t.ok(rows.has(B.key), 'the new leave is tombstoned')
  t.ok(rows.has(held), 'a tombstone the fold still authorizes survives the cap')
  t.absent(rows.has(inert), 'an inert tombstone is cleared to make room')
  t.ok(leave.acked(), 'and the leave is acked, since it landed durably')
})

test('REGRESSION (MIR-43: a cap full of authorized tombstones refuses the durable row and the ack, not the revoke)', async (t) => {
  await freshPeer(t)
  wire(t)
  withMemberCap(t, 2)
  const { spaceId, B } = await spaceWithMember(t, 'MIR43-cap-full')
  const heldA = hex()
  const heldB = hex()
  for (const k of [heldA, heldB]) {
    await markApproval(spaceId, k)
    await persistLeftTombstone(spaceId, k, 1)
  }
  await openMemberView(spaceId)
  t.teardown(() => closeMemberView(spaceId))
  t.ok(await waitFor(() => isApprovedJoiner(spaceId, heldA) && isApprovedJoiner(spaceId, heldB), 8000), 'precondition: the fold authorizes both tombstoned keys')

  const leave = boundLeave(B, spaceId)
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg)

  const rows = await loadLeftTombstones(spaceId)
  t.absent(rows.has(B.key), 'no durable row past the cap')
  t.ok(rows.has(heldA) && rows.has(heldB), 'no load-bearing tombstone is evicted')
  t.ok(isLeft(spaceId, B.key), 'the leave still holds in memory')
  t.absent(await hasOwnApproval(spaceId, B.key), 'our vouch for B is still revoked')
  t.absent(leave.acked(), 'no ack, since the tombstone did not land durably')
})

// B admitted on the leave's own socket, in `spaces`, alongside any other identities on that socket.
function admitOnSocket(leave, B, spaces, others = []) {
  let destroyed = 0
  leave.socket.destroy = () => { destroyed++ }
  connectedPeers.set(B.key, { socket: leave.socket, profileKey: B.key, displayName: 'Bob', avatar: null, spaces: new Set(spaces), looseCatalogKeys: new Map() })
  socketToPeers.set(leave.socket, new Set([B.key, ...others]))
  return () => destroyed
}

test('REGRESSION (MIR-47: a leave that strips a socket of its last admitted peer ends the socket, after capturing the leaver)', async (t) => {
  await freshPeer(t)
  wire(t)
  const { spaceId, B } = await spaceWithMember(t, 'MIR47-last')
  // Records a membership read never touches, so only a whole-core capture holds them.
  for (let i = 0; i < 24; i++) await B.bee.put('filler/' + i, { i })

  const leave = boundLeave(B, spaceId)
  const destroyed = admitOnSocket(leave, B, [spaceId])
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg)

  t.ok(leave.acked(), 'precondition: the leave was applied')
  t.is(destroyed(), 1, 'the socket is ended')
  t.absent(socketToPeers.has(leave.socket), 'and carries nobody admitted')
  const held = getStore().get({ key: B.bee.core.key })
  await held.ready()
  t.comment(`leaver core here: length=${held.length} contiguous=${held.contiguousLength}`)
  t.ok(held.length > 24 && held.contiguousLength === held.length, 'the leaver\'s whole bee is held here to re-host')
  await held.close()
})

test('a leaver still admitted elsewhere on the socket keeps it', async (t) => {
  await freshPeer(t)
  wire(t)
  const { spaceId, B } = await spaceWithMember(t, 'MIR47-shared')

  const inOtherSpace = boundLeave(B, spaceId)
  const destroyedA = admitOnSocket(inOtherSpace, B, [spaceId, hex()])
  await handleLeaveFrame(inOtherSpace.socket, inOtherSpace.peerInfo, inOtherSpace.msg)
  t.ok(inOtherSpace.acked(), 'precondition: the leave was applied')
  t.is(destroyedA(), 0, 'a peer that still shares a space with us keeps its socket')
  resetRegistries()

  const { spaceId: second, B: C } = await spaceWithMember(t, 'MIR47-cohabited')
  const withNeighbour = boundLeave(C, second)
  const destroyedB = admitOnSocket(withNeighbour, C, [second], [hex()])
  await handleLeaveFrame(withNeighbour.socket, withNeighbour.peerInfo, withNeighbour.msg)
  t.ok(withNeighbour.acked(), 'precondition: the second leave was applied')
  t.is(destroyedB(), 0, 'a socket that still carries another admitted identity stays up')
})

function enforceTopicRefs(t) {
  const prev = { ...getRuntimeConfig() }
  setRuntimeConfig({ ...prev, topicRefsEnforced: true })
  t.teardown(() => setRuntimeConfig(prev))
}

// The leave named by reference, on a socket that carries our Noise key and the leaver's.
async function refLeave(peer, spaceId) {
  const leave = boundLeave(peer, spaceId)
  const topic = (await getSpace(spaceId)).topic
  spaceTopics.set(spaceId, topic)
  leave.socket.publicKey = crypto.keyPair().publicKey
  leave.socket.remotePublicKey = leave.peerInfo.publicKey
  const { spaceId: _named, ...rest } = leave.msg
  leave.msg = { ...rest, topicRef: deriveTopicRef(topic, leave.peerInfo.publicKey) }
  return { ...leave, topic }
}

test('a leave named by reference is applied and acked by reference', async (t) => {
  await freshPeer(t)
  const emitted = wire(t)
  const { spaceId, B } = await spaceWithMember(t, 'ref-leave')
  const leave = await refLeave(B, spaceId)
  const acks = []
  socketMsgHandlers.set(leave.socket, { send: (str) => acks.push(JSON.parse(str)) })
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg, spaceId)

  t.ok((await loadLeftTombstones(spaceId)).has(B.key), 'B is durably tombstoned')
  t.ok(emitted.some((e) => e.name === 'event:member-left' && e.payload.publicKey === B.key), 'member-left is announced')
  const ack = acks.find((f) => f.type === PEER_FRAME.LEAVE_ACK)
  t.is(ack?.topicRef, deriveTopicRef(leave.topic, leave.socket.publicKey), 'the ack names the space by our ref')
  t.absent('spaceId' in (ack || {}), 'and carries no spaceId')
})

test('a leave by reference that names none of our spaces is ignored', async (t) => {
  await freshPeer(t)
  const emitted = wire(t)
  const { spaceId, B } = await spaceWithMember(t, 'ref-leave-unknown')
  const leave = await refLeave(B, spaceId)
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg, null)

  t.absent(isLeft(spaceId, B.key), 'nothing applied')
  t.absent(leave.acked(), 'no ack')
  t.absent(emitted.some((e) => e.name === 'event:member-left'))
})

test('a leave by spaceId is still applied and acked by spaceId with topic refs enforced', async (t) => {
  await freshPeer(t)
  wire(t)
  enforceTopicRefs(t)
  const { spaceId, B } = await spaceWithMember(t, 'id-leave-enforced')
  const leave = boundLeave(B, spaceId)
  const acks = []
  socketMsgHandlers.set(leave.socket, { send: (str) => acks.push(JSON.parse(str)) })
  await handleLeaveFrame(leave.socket, leave.peerInfo, leave.msg, null)

  t.ok(isLeft(spaceId, B.key), 'applied')
  t.is(acks.find((f) => f.type === PEER_FRAME.LEAVE_ACK)?.spaceId, spaceId, 'acked by spaceId')
})

test('with topic refs enforced a pending leave goes by reference, and only to a socket that named the space', async (t) => {
  await freshPeer(t)
  wire(t)
  enforceTopicRefs(t)
  const topic = hex()
  const spaceId = topic.slice(0, 16)
  registerPendingLeave(spaceId, topic, 1000)
  const applied = []
  configurePendingLeaves((id) => applied.push(id))

  const socketOf = () => {
    const sent = []
    const socket = { publicKey: crypto.keyPair().publicKey, remotePublicKey: crypto.keyPair().publicKey }
    const handler = { send: (str) => sent.push(JSON.parse(str)) }
    return { socket, handler, sent }
  }
  const stranger = socketOf()
  sendPendingLeaveFrames(stranger.socket, stranger.handler)
  t.alike(stranger.sent, [], 'a socket that has not named the space is told nothing')

  const member = socketOf()
  noteSpaceProven(member.socket, spaceId)
  sendPendingLeaveFrames(member.socket, member.handler, { onlySpaceId: spaceId })
  const frame = member.sent.find((f) => f.type === PEER_FRAME.LEAVE)
  t.is(frame?.topicRef, deriveTopicRef(topic, member.socket.publicKey), 'named by our ref on that socket')
  t.absent('spaceId' in (frame || {}), 'and not by spaceId')

  handleLeaveAckFrame(stranger.socket, { type: PEER_FRAME.LEAVE_ACK, topicRef: deriveTopicRef(topic, stranger.socket.remotePublicKey), profileKey: hex() })
  t.ok(hasPendingLeave(spaceId), 'an ack on a socket the leave never went out on clears nothing')
  handleLeaveAckFrame(member.socket, { type: PEER_FRAME.LEAVE_ACK, topicRef: deriveTopicRef(topic, member.socket.remotePublicKey), profileKey: hex() })
  t.absent(hasPendingLeave(spaceId), 'the ack by reference clears the pending leave')
  t.alike(applied, [spaceId])
})
