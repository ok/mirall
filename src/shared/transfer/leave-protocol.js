// Leaving a space, and the two replay lanes that make a leave stick when nobody was listening.
//
// Three concerns, one lifecycle: applying an inbound `leave` frame (adopt the leaver's vouchees,
// tombstone, revoke, ack), replaying our own outbound leave until a co-member acks it durably, and
// replaying a withdrawn join request until a member writes the converging denial. They share the
// leaving-space marker, the purged-topic join/leave helpers and the ack-eligibility bookkeeping,
// and nothing outside them touches those — which is what makes this a module rather than a section.
//
// Takes its collaborators through init() rather than importing swarm.js: the swarm handle and the
// IPC channel are both reassigned across a restart, and getLocalBinding caches per-drive-key
// signatures that only the connection layer can mint.
import b4a from 'b4a'
import { getProfileKey, revokeApproval, adoptVouchees } from '../spaces/profile.js'
import { getSpace, removeMember, persistLeftTombstone } from '../spaces/space.js'
import { leaveFrameBound } from './handshake-guard.js'
import { destroyContentPeerSockets } from './content-swarm.js'
import { record } from '../audit/audit-log.js'
import { peerLeft } from '../audit/network-watch.js'
import { markLeft } from '../spaces/member-registry.js'
import { connectedPeers, socketToPeers, spaceTopics, spaceDiscoveries, socketMsgHandlers } from './swarm-registries.js'

let presence = null
let log = null
let getLocalBinding = () => null
let getRevokeServesHook = () => null
// Read at call time, not captured: initSwarm and destroySwarm reassign both handles.
let getSwarm = () => null
let getIpc = () => null

export function initLeaveProtocol(deps) {
  presence = deps.presence
  log = deps.log
  getLocalBinding = deps.getLocalBinding
  getRevokeServesHook = deps.getRevokeServesHook
  getSwarm = deps.getSwarm
  getIpc = deps.getIpc
}

// spaceIds whose teardown is in flight. Read all over the worker (files:list and size reads
// short-circuit on it so they never race a drive being closed), which is why it is exported
// through three accessors rather than as the Set.
const leavingSpaces = new Set()
export function markSpaceLeaving(spaceId) { leavingSpaces.add(spaceId) }
export function unmarkSpaceLeaving(spaceId) { leavingSpaces.delete(spaceId) }
export function isSpaceLeaving(spaceId) { return leavingSpaces.has(spaceId) }

// spaceId (we are leaving) → Set<profileKeyHex> of co-members that applied our leave
const leaveAcks = new Map()

function memberSnapshot (space, publicKey) {
  return {
    spaceName: space?.name ?? null,
    memberName: (space?.members || []).find((m) => m.publicKey === publicKey)?.displayName ?? null,
  }
}

function recordMemberLeft (spaceId, profileKey, snapshot) {
  record('member.left', {
    actor: { type: 'peer', key: profileKey, name: snapshot.memberName },
    space: { id: spaceId, name: snapshot.spaceName },
    target: { kind: 'member', id: profileKey, name: snapshot.memberName },
  })
}

export async function handleLeaveFrame(socket, peerInfo, msg) {
  const { spaceId, profileKey } = msg
  if (!spaceId || !profileKey) return

  // Our own teardown destroys the sockets that clear the auth index, so an inbound
  // frame for a space we're leaving races into the rejection below — drop it quietly.
  if (leavingSpaces.has(spaceId)) return

  // Accept iff the sender proves it controls profileKey on THIS connection: the fast path is the
  // per-socket auth index; the robust path is the frame's identity binding, which survives the
  // teardown/reconnect race that clears or has-not-yet-populated that index. Additive — the binding
  // proof is strictly stronger than the index, so a third party still cannot evict a member.
  const onSocket = socketToPeers.get(socket)?.has(profileKey) || false
  if (!onSocket && !leaveFrameBound(peerInfo, msg)) {
    log.warn('leave frame rejected — sender not authenticated on socket and no valid binding')
    return
  }

  const space = await getSpace(spaceId)
  if (!space?.members) return

  // Take over the leaver's vouchees before touching anything else. The revoke below unroots the
  // leaver, and from then on the fold stops walking its bee, so the subtree it alone vouched for
  // could never be recovered. The leaver is connected right now, which is the best window there is
  // to read that record. When it is unreadable, apply NOTHING: the replication-driven path retries
  // once the departure record lands, which is strictly better than tombstoning here while our vouch
  // still stands (a tombstone would suppress every retry).
  if (!(await adoptVouchees(spaceId, profileKey))) {
    log.warn('leave frame deferred — leaver record unreadable, cannot adopt:', profileKey.slice(0, 12))
    return
  }

  // After the deferral above, so a leave we did not apply records nothing.
  const leftSnapshot = memberSnapshot(space, profileKey)

  // Tombstone the leaver FIRST so the member-view fold can't re-add them from their stale
  // still-active record (their del-record may not replicate before they disconnect). Set
  // before removeMember so any in-flight re-derive already subtracts them. Persist it so the
  // subtraction survives a restart, incl. the creator/root where revokeApproval is a no-op.
  // msg.ts is untrusted wire data used as the durable self-clear stamp — reject a non-finite /
  // non-positive value (a negative would make tombstoneActive false and re-add the leaver). It is
  // the leaver's own clock, same as the member/<S>.ts a rejoin writes, so the comparison stays
  // single-clock in the common path.
  const leaveTs = (typeof msg.ts === 'number' && Number.isFinite(msg.ts) && msg.ts > 0) ? msg.ts : Date.now()
  markLeft(spaceId, profileKey, leaveTs)
  let durablyApplied = true
  try { await persistLeftTombstone(spaceId, profileKey, leaveTs) } catch (err) {
    durablyApplied = false
    log.warn('persist leave tombstone failed:', err.message)
  }

  // Revoke our own approval so a later rejoin needs fresh approval, not a silent re-admit off the
  // surviving grow-only record. Unconditional + idempotent: a leaver already pruned by the fold (or a
  // duplicate frame) must still lose our vouch. No-op for the creator (we hold no approval for the
  // root). Safe to unroot the leaver here — its vouchees were adopted above.
  try { await revokeApproval(spaceId, profileKey) } catch (err) {
    durablyApplied = false
    log.warn('approval revoke on leave failed:', err.message)
  }

  // Ack the leaver over its own socket so it can stop waiting (awaitLeaveAcks) — but ONLY once the
  // durable tombstone + revoke actually landed, since that is exactly what the ack attests. A
  // swallowed durable failure must not resolve the wait early; the leaver falls back to the cap.
  const selfKey = getProfileKey()
  if (durablyApplied && selfKey) {
    try { socketMsgHandlers.get(socket)?.send(JSON.stringify({ type: 'leave-ack', spaceId, profileKey: b4a.toString(selfKey, 'hex') })) } catch {}
  }

  const removed = await removeMember(spaceId, profileKey)
  if (!removed) return
  log.info('peer left space (leave frame):', profileKey.slice(0, 12) + '...', '→', spaceId)

  presence.clear(profileKey, spaceId)   // the leaver is offline in this space immediately
  peerLeft(profileKey, spaceId)         // ...but that is a LEAVE; member.left carries it

  const peer = connectedPeers.get(profileKey)
  if (peer) {
    peer.spaces.delete(spaceId)
    peer.looseCatalogKeys?.delete(spaceId)
    if (peer.spaces.size === 0) {
      connectedPeers.delete(profileKey)
      const set = socketToPeers.get(peer.socket)
      if (set) {
        set.delete(profileKey)
        if (set.size === 0) socketToPeers.delete(peer.socket)
      }
      // The overlay content channel rides the CONTENT socket, not this one: a peer we no longer
      // share any space with must lose that socket too, or we keep serving it bulk bytes.
      try { destroyContentPeerSockets(profileKey) } catch {}
    }
  }
  // Their leave revokes our serve grants for this space: the grant is cached per (peer, path) at
  // request time and re-checked against that cache only, so a membership change has to invalidate
  // it actively — otherwise an in-flight transfer keeps streaming to a peer no longer entitled.
  getRevokeServesHook()?.(spaceId, profileKey)

  recordMemberLeft(spaceId, profileKey, leftSnapshot)

  getIpc().emit('event:member-left', { spaceId, publicKey: profileKey })
  getIpc().emit('event:files-updated', { spaceId })
}

// ── pending outbound leaves (leave-while-alone recovery) ────────────────────────
// spaceId → { topic, ts }. A leave that provably reached no member is re-announced on
// every new connection until a co-member acks its durable apply. Seeded from the
// pendingleave/ markers at boot (the space record itself is already purged); the worker
// injects onApplied to clear the marker + leave the topic. ts is the ORIGINAL leave
// stamp so a genuine later rejoin (strictly newer member/<S> ts) always outranks the
// replayed tombstone on co-members.
const pendingLeaves = new Map()
const pendingLeaveFramesSent = new WeakMap()   // socket → Set<spaceId> (ack eligibility for the record-less space)
let onPendingLeaveApplied = null

export function configurePendingLeaves(onApplied) { onPendingLeaveApplied = onApplied }

export function registerPendingLeave(spaceId, topicHex, ts) {
  pendingLeaves.set(spaceId, { topic: topicHex, ts })
}

export function unregisterPendingLeave(spaceId) { pendingLeaves.delete(spaceId) }

export function hasPendingLeave(spaceId) { return pendingLeaves.has(spaceId) }

// Join/leave the topic of a PURGED space (both leave-replay and cancel-replay need this — the
// space record is gone, so joinSpaceTopic can't read it). Return whether they acted, for logging.
function joinPurgedSpaceTopic(spaceId, topicHex) {
  const swarm = getSwarm()
  if (!swarm || spaceDiscoveries.has(spaceId)) return false
  spaceTopics.set(spaceId, topicHex)
  spaceDiscoveries.set(spaceId, swarm.join(b4a.from(topicHex, 'hex'), { server: true, client: true }))
  return true
}

async function leavePurgedSpaceTopic(spaceId) {
  const topicHex = spaceTopics.get(spaceId)
  if (!topicHex) return false
  try { await getSwarm().leave(b4a.from(topicHex, 'hex')) } catch {}
  spaceTopics.delete(spaceId)
  spaceDiscoveries.delete(spaceId)
  return true
}

export function joinPendingLeaveTopic(spaceId, topicHex) {
  if (joinPurgedSpaceTopic(spaceId, topicHex)) log.info('joined topic for pending-leave replay:', spaceId)
}

export async function leavePendingLeaveTopic(spaceId) {
  if (await leavePurgedSpaceTopic(spaceId)) log.info('left pending-leave topic:', spaceId)
}

export function sendPendingLeaveFrames(socket, msgHandler) {
  if (pendingLeaves.size === 0) return
  const profileKey = getProfileKey()
  if (!profileKey) return
  const profileKeyHex = b4a.toString(profileKey, 'hex')
  let sent = pendingLeaveFramesSent.get(socket)
  if (!sent) pendingLeaveFramesSent.set(socket, (sent = new Set()))
  for (const [spaceId, { ts }] of pendingLeaves) {
    sent.add(spaceId)
    try {
      msgHandler.send(JSON.stringify({ type: 'leave', spaceId, profileKey: profileKeyHex, ts, ...(getLocalBinding() || {}) }))
    } catch (err) {
      log.debug('pending-leave frame send failed:', err.message)
    }
  }
}

export function sendLeaveFrameToConnectedPeers(spaceId) {
  if (socketMsgHandlers.size === 0) return
  const profileKey = getProfileKey()
  if (!profileKey) return
  const profileKeyHex = b4a.toString(profileKey, 'hex')
  leaveAcks.set(spaceId, new Set())   // collect co-member acks BEFORE the frames go out (no missed-ack race)
  const payload = JSON.stringify({
    type: 'leave',
    spaceId,
    profileKey: profileKeyHex,
    ts: Date.now(),
    ...(getLocalBinding() || {}),
  })
  for (const [, handler] of socketMsgHandlers) {
    try { handler.send(payload) } catch (err) {
      log.warn('leave frame send failed:', err.message)
    }
  }
}

export function leaveAcksSatisfied(expectedKeys, receivedSet) {
  for (const k of expectedKeys) if (!receivedSet.has(k)) return false
  return true
}

// Wait (bounded) for the connected members of a space to confirm they applied our leave — an
// observed signal that the load-bearing revokeApproval ran on our approvers before we tear
// down. Resolves early on full coverage; falls back to the cap for peers on older releases
// (which never ack) or a straggler. No connected members ⇒ nothing to wait for.
export async function awaitLeaveAcks(spaceId, { capMs = 2000, pollMs = 50, floorMs = 0 } = {}) {
  const received = leaveAcks.get(spaceId)
  const expected = new Set(presence.onlineIn(spaceId))
  try {
    if (!received || expected.size === 0) return true
    const start = Date.now()
    for (;;) {
      const elapsed = Date.now() - start
      // Hold at least floorMs even once every ack lands: an ack proves the co-member ran its
      // revoke, but NOT that it pulled our `del member/<S>` block (authored just before the frame)
      // so it can re-host the departure to members offline at leave time. The floor preserves a
      // replication window for that block.
      if (elapsed >= floorMs && leaveAcksSatisfied(expected, received)) return true
      if (elapsed >= capMs) return false
      await new Promise((r) => setTimeout(r, pollMs))
    }
  } finally {
    // Snapshot the acked keys before dropping the ledger, so the pending-leave arm decision can
    // ask "which members provably applied the leave" — the boolean return conflates that with
    // "nobody was connected" (vacuous true), which would skip the marker exactly when a member
    // dropped mid-leave.
    if (received) lastLeaveAckedKeys.set(spaceId, new Set(received))
    leaveAcks.delete(spaceId)
  }
}

// spaceId → Set<keyHex> of members that acked our most recent leave (populated by awaitLeaveAcks).
const lastLeaveAckedKeys = new Map()
export function takeLeaveAckedKeys(spaceId) {
  const set = lastLeaveAckedKeys.get(spaceId)
  lastLeaveAckedKeys.delete(spaceId)
  return set || new Set()
}

export function handleLeaveAckFrame(socket, msg) {
  const { spaceId, profileKey } = msg
  if (!spaceId || !profileKey) return
  // A pending-leave replay ack arrives on a socket with no live handshake for the purged
  // space (we no longer handshake it), so the strict rule below would drop it. Accept it
  // from a socket this pending frame went out on: the Noise session pins the counterparty,
  // and the worst a false ack does is stop the re-announce — the pre-marker behavior.
  if (pendingLeaves.has(spaceId) && pendingLeaveFramesSent.get(socket)?.has(spaceId)) {
    pendingLeaves.delete(spaceId)
    log.info('pending leave acked — clearing marker:', spaceId)
    Promise.resolve(onPendingLeaveApplied?.(spaceId)).catch((err) => log.debug('pending-leave clear failed:', err.message))
  }
  // Only count an ack from a peer that authenticated as this profileKey on this socket, so a peer
  // can't forge acks for other members and collapse the leaver's flush wait early.
  if (!socketToPeers.get(socket)?.has(profileKey)) return
  leaveAcks.get(spaceId)?.add(profileKey)
}

// ── pending outbound cancels (withdraw-a-request delivery) ──────────────────────
// A withdrawing pending joiner must reach at least one member showing its request; that member
// writes a durable denied tombstone which replicates to the rest. Re-announced on every new
// connection until an applied ack lands. In-memory: cleared on restart.
const pendingCancels = new Map()   // spaceId → { topic, joinerKey, attempts }
const pendingCancelFramesSent = new WeakMap()   // socket → Set<spaceId> (ack eligibility)
// Bound the replay so an abandoned withdrawal to an always-offline space can't hold the topic for
// the whole session; a member reached before the cap converges it, past it we give up (a member
// offline the entire time keeps the stale request — the documented in-memory-only residual).
const MAX_CANCEL_ATTEMPTS = 30
let onPendingCancelApplied = null

export function configurePendingCancels(onApplied) { onPendingCancelApplied = onApplied }

export function registerPendingCancel(spaceId, topicHex, joinerKey) {
  pendingCancels.set(spaceId, { topic: topicHex, joinerKey, attempts: 0 })
}

export function hasPendingCancel(spaceId) { return pendingCancels.has(spaceId) }

export function joinPendingCancelTopic(spaceId, topicHex) { joinPurgedSpaceTopic(spaceId, topicHex) }
export async function leavePendingCancelTopic(spaceId) { await leavePurgedSpaceTopic(spaceId) }

export function sendPendingCancelFrames(socket, msgHandler) {
  if (pendingCancels.size === 0) return
  let sent = pendingCancelFramesSent.get(socket)
  if (!sent) pendingCancelFramesSent.set(socket, (sent = new Set()))
  for (const [spaceId, pc] of pendingCancels) {
    try { msgHandler.send(JSON.stringify({ type: 'membership:cancel', spaceTopic: pc.topic, joinerKey: pc.joinerKey })) } catch { continue }
    sent.add(spaceId)
    if (++pc.attempts >= MAX_CANCEL_ATTEMPTS) {
      pendingCancels.delete(spaceId)
      leavePurgedSpaceTopic(spaceId).catch((err) => log.debug('pending-cancel give-up leave failed:', err.message))
    }
  }
}

// Initial send of a freshly-registered cancel on every current connection. Goes through
// sendPendingCancelFrames (not broadcastMembershipCancel) so ack eligibility is recorded per socket
// — otherwise a member acking over the existing connection would be rejected by handleMembershipCancelAck.
export function sendPendingCancelToConnected() {
  for (const [socket, handler] of socketMsgHandlers) sendPendingCancelFrames(socket, handler)
}

// A member acked our cancel with applied:true (it wrote the converging tombstone) on a socket we
// actually sent the cancel on — stop replaying and drop the topic. The socket + frame-sent check
// mirrors handleLeaveAckFrame: a peer that never received our cancel can't clear it.
export function handleMembershipCancelAck(socket, msg) {
  if (!msg.applied || typeof msg.spaceTopic !== 'string') return
  for (const [spaceId, pc] of pendingCancels) {
    if (pc.topic !== msg.spaceTopic) continue
    if (!pendingCancelFramesSent.get(socket)?.has(spaceId)) return
    pendingCancels.delete(spaceId)
    Promise.resolve(onPendingCancelApplied?.(spaceId)).catch((err) => log.debug('pending-cancel clear failed:', err.message))
    return
  }
}

// What destroySwarm calls instead of clearing six containers by hand. The two onApplied hooks are
// injected by the worker per boot, so they drop with everything else.
export function resetLeaveProtocol() {
  leavingSpaces.clear()
  leaveAcks.clear()
  pendingLeaves.clear()
  lastLeaveAckedKeys.clear()
  pendingCancels.clear()
  onPendingLeaveApplied = null
  onPendingCancelApplied = null
}

// Membership removal is the member-set fold's job (member-registry): a peer drops from the
// set when their replicated `del member/S` (leave) lands, and stays an offline member
// otherwise. This layer deliberately never prunes membership on disconnect — admission is
// separate from membership display, and a dead socket says nothing about membership.
