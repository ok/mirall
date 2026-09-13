// Membership: the four peer-frame handlers behind mirall/handshake's membership control channel,
// the durable member registry the composition root folds with, and the approve/deny surface the
// renderer drives. One module because a knock reaches us on both paths and must resolve the same
// way whichever arrives first.
//
// `ipc` and `log` are bound once by createMembership, which the entry calls before boot() — the
// registry and the frame router are boot collaborators, so they must exist before the root does.
// Binding them here rather than closing over them keeps every handler at module scope, where its
// own size is visible.

import { record } from '../../shared/audit/audit-log.js'
import { peerActor, selfActor, systemActor, targetRef } from '../../shared/audit/audit-record.js'
import { OUTCOME, TARGET_KIND } from '../../shared/contract/audit-kinds.js'
import { CODES } from '../../shared/contract/errors.js'
import { PEER_FRAME } from '../../shared/contract/peer-frames.js'
import { AppError } from '../../shared/core/errors.js'
import { getResourceCaps, isHandshakeIdentityBindingEnabled } from '../../shared/core/runtime-config.js'
import { sanitizeAvatar } from '../../shared/identity-limits.js'
import { reconcileAssertedRoot } from '../../shared/spaces/creator-root.js'
import { classifyInvite } from '../../shared/spaces/invite-policy.js'
import { closeMemberView, dropTombstone, isApprovedJoiner, isDeniedJoiner, isLeft, openMemberView } from '../../shared/spaces/member-registry.js'
import { knockSettledByRecords, knockInviteVerdict } from '../../shared/spaces/knock-policy.js'
import { captureJoinerMembership, getIdentitySigner, markRequest, markRequestDenied, readProfileRecord } from '../../shared/spaces/profile.js'
import { clearCreatorDivergence, clearJoinRequest, getSpace, getSpaceContentKey, listJoinRequests, listPendingRequests, markCreatorDivergence, materializeOwnDrive, pinCreatorKey, purgeSpace, recordApproval, recordJoinRequest } from '../../shared/spaces/space.js'
import { makeKeyedCoalescer } from '../../shared/core/coalesce.js'
import { forgetUnreferencedPeerCores } from '../../shared/storage/leftover.js'
import { checkGrantAssertion, clampDisplayName } from '../../shared/transfer/handshake-guard.js'
import { openSealedSck } from '../../shared/transfer/sck-seal.js'
import { broadcastMembershipCancel, broadcastProfileUpdate, cleanupSpaceDrives, getBoundSignerKey, getConnectedMemberMeta, isApprovedMember, leaveSpaceTopic, markSpaceLeaving, readmitConnectedMembers, resolveInvite, sendMembershipDeny, sendMembershipGrant, unmarkSpaceLeaving } from '../../shared/transfer/swarm.js'
import { peerActorIn, spaceRefOf } from '../audit-refs.js'
import b4a from 'b4a'

let ipc = null
let log = null
let dropSpaceDownloadRoot = null

// One poke per followed member per share-record append — K raw frames while K records
// replicate, each driving a 3-IPC useShares refresh incl. per-member network head-pulls.
// Coalesce per space at the source; files-updated is additionally coalesced downstream
// into event:reconcile by the hint bus.
const sharesPoke = makeKeyedCoalescer((spaceId) => {
  ipc.emit('event:shares-updated', { spaceId })
  ipc.emit('event:files-updated', { spaceId })
}, { intervalMs: 250 })

// Durable (Tier-1) membership: derive each space's member set from replicated records and
// write it into space.members. Swarm metadata + the IPC emitter are injected so the registry
// needs no swarm import. (Runs alongside the handshake/gossip path under a conservative
// contract: it only ever agrees-or-adds, and removes a member only once the replicated
// evidence and the live connection state agree — a live handshake always outranks stale
// records.)
const memberRegistry = {
  metaFor: (spaceId, key) => getConnectedMemberMeta(spaceId, key),
  isConnected: (spaceId, key) => !!getConnectedMemberMeta(spaceId, key),
  profileFor: (spaceId, key) => readProfileRecord(key, spaceId),
  readmitConnected: (spaceId, keys) => readmitConnectedMembers(spaceId, keys),
  // A change in the derived member set changes whose files + shares we surface (both lists
  // read peer content keyed on space.members), so refresh all three renderer views — not
  // just the member list. On a removal these events are the only signal that drops the gone
  // member's content from the file/share views.
  emitMembersUpdated: (spaceId) => {
    ipc.emit('event:members-updated', { spaceId })
    ipc.emit('event:shares-updated', { spaceId })
    ipc.emit('event:files-updated', { spaceId })
  },
  emitJoinRequest: (spaceId, req) => {
    ipc.emit('event:member-join-request', { spaceId, ...req })
    auditJoinRequest(spaceId, req.publicKey, req.displayName)
  },
  emitJoinRequestsUpdated: (spaceId) => ipc.emit('event:join-requests-updated', { spaceId }),
  // A followed member added/removed a share/<space>/* record (shares live in the profile bee, which
  // doesn't move the member set). Poke the share + file lists so a derived-only member's share
  // surfaces without waiting for an unrelated member-set change.
  emitSharesUpdated: (spaceId) => sharesPoke.poke(spaceId),
}

const MEMBERSHIP_HANDLERS = Object.freeze({
  [PEER_FRAME.MEMBERSHIP_REQUEST]: (msg) => onJoinRequest(msg),
  [PEER_FRAME.MEMBERSHIP_GRANT]: (msg, ctx) => onGrant(msg, ctx),
  [PEER_FRAME.MEMBERSHIP_DENY]: (msg) => onDeny(msg),
  [PEER_FRAME.MEMBERSHIP_CANCEL]: (msg, ctx) => onCancel(msg, ctx),
})

async function handleMembershipControl(msg, ctx) {
  try {
    return await MEMBERSHIP_HANDLERS[msg.type]?.(msg, ctx)
  } catch (err) {
    log.warn('membership control failed:', msg?.type, '-', err.message)
  }
}

async function onJoinRequest(msg) {
  const spaceId = (msg.spaceTopic || '').slice(0, 16)
  const space = spaceId ? await getSpace(spaceId) : null
  if (!space) return
  // Capture the leave-tombstone (the kept "this peer left" marker) BEFORE clearing it: a peer
  // mid-leave can still be transiently in space.members (handleLeaveFrame's removeMember hasn't
  // committed), so a peer we've observed leaving must go through fresh approval, never the
  // reconnect re-grant shortcut. It reads a different record than the approval below, so the two
  // are free to be read together.
  const hadLeft = isLeft(spaceId, msg.profileKey)
  const settled = knockSettledByRecords({
    selfPending: space.status === 'pending',
    isMember: (space.members || []).some((m) => m.publicKey === msg.profileKey),
    hadLeft,
    isApproved: isApprovedJoiner(spaceId, msg.profileKey),
  })
  if (settled === 'ignore') return
  // A fresh request means they want back in — lift any leave-tombstone (in-memory + durable) so the
  // gate and the fold treat them as a normal (re)joiner again.
  await dropTombstone(spaceId, msg.profileKey)
  const grant = () => {
    // Honor the same pause resolveJoinRequest enforces: while the creator-root conflict is
    // unresolved, hand out no content key. Harmless for a reconnecting member (it already holds
    // the SCK); load-bearing for the approved-but-keyless branch below, whose grant would be the
    // joiner's FIRST SCK delivery under the disputed trust anchor.
    if (space.creatorDivergence) { log.warn('re-grant blocked — creator root divergence unresolved:', spaceId); return }
    const sck = getSpaceContentKey(spaceId, space)
    if (sck) sendMembershipGrant(msg.profileKey, space.topic, b4a.toString(sck, 'hex'), space.creatorKey, boundSignerPk(msg.profileKey))
  }
  if (settled === 'regrant') return grant()

  // Resolving the invite is deferred past the settled verdicts on purpose: resolveInvite REVOKES
  // an expired link, so reading one for a peer we are about to re-grant retires a link nobody used.
  let inviteRec = null
  let inviteVerdict = null
  if (msg.inviteId) {
    inviteRec = await resolveInvite(space, msg.inviteId)
    inviteVerdict = classifyInvite(inviteRec)
  }
  const verdict = knockInviteVerdict({
    inviteVerdict,
    hasInviteRecord: !!inviteRec,
    hadLeft,
    isDenied: isDeniedJoiner(spaceId, msg.profileKey),
  })
  if (verdict === 'deny-expired' || verdict === 'deny-replay') {
    if (space.topic) sendMembershipDeny(msg.profileKey, space.topic)
    return
  }
  if (verdict === 'auto-approve') {
    await resolveJoinRequest(space, msg.profileKey, 'approve')
    return
  }

  const displayName = clampDisplayName(msg.displayName)
  // The frame budget already bounded the SIZE of what arrived; what it cannot check is the shape.
  // Every other avatar ingress sanitizes, and this one writes durably into the replicated profile
  // bee, so a peer-supplied `javascript:` or `data:text/html` value would replicate to co-members
  // and reach the renderer. Bounded by the storage cap, not the frame budget: an arrived frame is
  // by definition already under the frame cap.
  const avatar = sanitizeAvatar(msg.avatar, getResourceCaps().avatarMaxBytes)
  const changed = recordJoinRequest(spaceId, msg.profileKey, displayName, avatar)
  // The durable receipt runs on EVERY knock — markRequest short-circuits on an existing one,
  // so a re-announced (heartbeat) request is nearly free while a first write that failed
  // self-heals. A departed peer (hadLeft) that re-requests must write a FRESH receipt ts, so
  // co-members reading it via replication surface the rejoin instead of suppressing it
  // against our leave stamp. Only the renderer emit is deduped: an unchanged heartbeat
  // keeps the banner quiet, and this sits strictly AFTER the replay branches above, so a
  // re-knock still replays a lost grant/deny.
  await markRequest(spaceId, msg.profileKey, { displayName, avatar, refresh: hadLeft })
  if (changed || hadLeft) {
    ipc.emit('event:member-join-request', { spaceId, publicKey: msg.profileKey, displayName, avatar })
    auditJoinRequest(spaceId, msg.profileKey, displayName)
  }
}

// A knock reaches us two ways — the live membership:request frame, and the replicated fold when a
// co-member heard it first — and either can arrive first. Both record through here so the row
// appears regardless of path, and appears once. Cleared when the request resolves, so a later
// re-knock after a denial is recorded again.
const recordedJoinRequests = new Set()
const joinRequestKey = (spaceId, publicKey) => spaceId + '|' + publicKey

function auditJoinRequest(spaceId, publicKey, displayName) {
  const key = joinRequestKey(spaceId, publicKey)
  if (recordedJoinRequests.has(key)) return
  recordedJoinRequests.add(key)
  getSpace(spaceId).then((space) => {
    record('membership.requested', {
      actor: peerActor(publicKey, displayName || null),
      space: spaceRefOf(space),
      target: targetRef(TARGET_KIND.MEMBER, publicKey, displayName || null),
    })
  }).catch(() => {})
}

function forgetJoinRequestRecord(spaceId, publicKey) {
  recordedJoinRequests.delete(joinRequestKey(spaceId, publicKey))
}

// The bound ed25519 signer key of a currently-connected peer, as a buffer, to seal its SCK grant.
// A grant only reaches a connected peer, so this is the single reliable source (boundSignerKeys is
// populated from every verified identity frame); no need to thread it through the request record.
function boundSignerPk(profileKeyHex) {
  const hex = getBoundSignerKey(profileKeyHex)
  return hex ? b4a.from(hex, 'hex') : null
}

// Reconcile the granter's authenticated root assertion against our pin. noop with an
// assertion = an authenticated granter re-confirmed the pinned root, so a flagged divergence
// is no longer live (noop without one clears nothing); refuse = a confirmed conflict, the
// grant must stop. Returns { blocked, decision }.
async function reconcileGrantCreator(spaceId, space, asserted) {
  const pinnedIsAuthenticated = !!space.creatorKey && !space.creatorUnverified
  const decision = reconcileAssertedRoot({ pinned: space.creatorKey || null, pinnedIsAuthenticated, asserted })
  if (decision === 'noop' && asserted && space.creatorDivergence) {
    await clearCreatorDivergence(spaceId)
    ipc.emit('event:membership-creator-divergence', { spaceId })
  }
  if (decision === 'refuse') {
    record('security.creator_divergence', {
      actor: systemActor(),
      space: spaceRefOf(space),
      target: targetRef(TARGET_KIND.SPACE, spaceId, space?.name ?? null),
      subject: { pinned: space.creatorKey ?? null, asserted: asserted ?? null },
      outcome: OUTCOME.DENIED,
    })
    log.warn('membership:grant creator divergence — confirmed', space.creatorKey?.slice(0, 12) + '...', 'vs granter', asserted?.slice(0, 12) + '...')
    await markCreatorDivergence(spaceId)
    ipc.emit('event:membership-creator-divergence', { spaceId })
    return { blocked: true, decision }
  }
  return { blocked: false, decision }
}

async function onGrant(msg, ctx = {}) {
  const spaceId = (msg.spaceTopic || '').slice(0, 16)
  const space = spaceId ? await getSpace(spaceId) : null
  if (!space || space.status !== 'pending') return

  // Authenticate the member-set root assertion before trusting it. The granter is, by the read
  // gate, an authorized member; verifying its identity binding (the signature tying its profile
  // key to this socket's Noise key) proves it really is the peer it claims to be. We pin
  // creatorKey from THIS authenticated assertion, not from the bearer invite.
  const enforce = isHandshakeIdentityBindingEnabled()
  const verdict = checkGrantAssertion(ctx.peerInfo, msg, { enforceBinding: enforce })
  if (!verdict.ok) {
    log.warn('rejected membership:grant —', verdict.reason)
    return
  }
  // While binding enforcement is off the assertion is unverified, so we leave the provisional
  // invite pin untouched; an assertion is adopted or refused only once it is authenticated
  // (enforcement on).
  const asserted = enforce ? verdict.creator : null
  const { blocked, decision } = await reconcileGrantCreator(spaceId, space, asserted)
  if (blocked) return

  // The SCK arrives sealed to our bound signer key; a plaintext sck field is refused as a
  // downgrade. A sealed 32-byte SCK is exactly 80 bytes (32 + crypto_box_SEALBYTES) = 160 hex
  // chars; bound the length so a peer can't trigger a large allocation with a multi-megabyte
  // sckSealed.
  const signer = getIdentitySigner()
  if (typeof msg.sckSealed !== 'string' || !/^[0-9a-f]{160}$/i.test(msg.sckSealed) || !signer) return
  const sckBuf = openSealedSck(b4a.from(msg.sckSealed, 'hex'), signer)
  if (!sckBuf || sckBuf.length !== 32) return

  await materializeOwnDrive(spaceId, sckBuf)
  if (asserted && (decision === 'adopt' || decision === 'confirm')) await pinCreatorKey(spaceId, asserted)
  await broadcastProfileUpdate()
  await openMemberView(spaceId)
  // verdict.granterKey, not msg.profileKey: the grant frame (swarm.js sendMembershipGrant)
  // carries `granterKey` and no profileKey at all.
  //
  // How strong that attribution is depends on the same flag `asserted` above is gated on:
  // checkGrantAssertion verifies granterKey against the socket's identity binding only when
  // enforcement is ON, and returns it unverified when OFF (the shipped default). It is recorded
  // either way — the alternative is the '?' row for every user until the flag flips — but the
  // kind's tier B therefore describes the enforced case, not today's default.
  await recordGrantReceived(spaceId, verdict.granterKey)
  ipc.emit('event:membership-granted', { spaceId })
}

// A pending joiner withdrew their request (an ephemeral Tier-3 lifecycle signal) — drop our banner. Only the
// members actually showing it author a durable tombstone (the cancel is broadcast to every
// socket; don't pollute uninvolved members' bees) so the withdrawal converges + survives restart.
async function onCancel(msg, ctx = {}) {
  const spaceId = (msg.spaceTopic || '').slice(0, 16)
  if (!spaceId || typeof msg.joinerKey !== 'string') return
  const showing = listJoinRequests(spaceId).some((r) => r.publicKey === msg.joinerKey)
  const had = clearJoinRequest(spaceId, msg.joinerKey)
  if (showing) await markRequestDenied(spaceId, msg.joinerKey)
  // Ack so the joiner stops replaying. applied:true whenever the withdrawal is DURABLY applied here
  // (we just wrote the tombstone, or already hold one from a prior replay) — re-attesting on every
  // replay so a single lost ack can't leave the joiner replaying forever. isDeniedJoiner reflects
  // the tombstone that replicates the withdrawal to co-members.
  const applied = showing || isDeniedJoiner(spaceId, msg.joinerKey)
  ctx.reply?.({ type: PEER_FRAME.MEMBERSHIP_CANCEL_ACK, spaceTopic: msg.spaceTopic, joinerKey: msg.joinerKey, applied })
  if (had || showing) ipc.emit('event:join-requests-updated', { spaceId })
}

async function onDeny(msg) {
  const spaceId = (msg.spaceTopic || '').slice(0, 16)
  if (!spaceId) return
  // The request was rejected — the joiner never became a member, so drop the
  // pending space entirely instead of leaving it stranded in their list.
  const space = await getSpace(spaceId)
  if (space?.status === 'pending') await discardPendingSpace(spaceId)
  ipc.emit('event:membership-denied', { spaceId })
}

// Single chokepoint for a member resolving a pending join request (an ephemeral Tier-3
// request becoming durable Tier-1 membership). On
// approve it authors the approval record (recordApproval) and hands the joiner the SCK
// grant directly; co-members converge on the new member by replicating that record (the
// fold re-derives) — no approval gossip. On deny it signals the joiner and tells
// co-members to drop the banner. Routing all decision sites (manual approve, auto-admit,
// deny) through here means none can omit a step. outcome: 'approve' | 'deny'.
async function resolveJoinRequest(space, joinerKey, outcome) {
  // The knock is settled; forget it so a genuine later re-knock (e.g. after a denial) records
  // again rather than being swallowed by the first one's dedupe.
  forgetJoinRequestRecord(space.spaceId, joinerKey)
  const spaceId = space.spaceId
  if (outcome === 'approve') {
    // A confirmed creator-root conflict disputes the roster's trust anchor — handing out the
    // SCK now would admit members under an unresolved identity split. This check is what makes
    // the divergence banner's "approvals are paused" claim true.
    if (space.creatorDivergence) {
      log.warn('approval blocked — creator root divergence unresolved:', spaceId)
      throw new AppError(CODES.CREATOR_DIVERGENCE_UNRESOLVED, 'approvals are paused while the creator root conflict is unresolved')
    }
    const sck = getSpaceContentKey(spaceId, space)
    if (!sck) return false
    await recordApproval(spaceId, joinerKey)
    // The read-model is already correct here (member approved, request cleared), so clear the
    // approver's banner now instead of gating it on the grant/capture below — matches the deny path.
    ipc.emit('event:join-requests-updated', { spaceId })
    // Grant FIRST so the joiner flips to approved promptly — delaying it widens a race where a
    // co-member's (no-op) deny reaches a still-pending joiner and makes it discard the space.
    let delivered = false
    if (space.topic) {
      // The grant is sealed to the joiner's bound signer key, read from its live connection
      // (the joiner must be connected to be granted). Surface a failure loudly rather than leaving
      // the joiner silently stuck on "waiting for approval".
      const signerPk = boundSignerPk(joinerKey)
      delivered = sendMembershipGrant(joinerKey, space.topic, b4a.toString(sck, 'hex'), space.creatorKey, signerPk)
      if (!delivered) log.warn('approval grant not delivered —', joinerKey.slice(0, 8), '— signer key', signerPk ? 'present' : 'missing')
    }
    // THEN durably capture the joiner's OWN profile core while it is still connected (it stays
    // connected through this awaited handler). Without this, a joiner that disconnects right after
    // approval leaves NO peer holding its record, so the OR-Set fold can never converge it on
    // anyone — the owner included. We serve it onward via our member-view follow. The capture is
    // best-effort and time-bounded so slow replication can't stall the approval; the joiner
    // usually hasn't authored/replicated its member record yet at this instant, so a miss here is
    // normal and the fold converges it later anyway — keep it at debug.
    const captured = await captureJoinerMembership(joinerKey, spaceId)
    if (!captured) log.debug('approval: joiner membership record not captured —', joinerKey.slice(0, 8))
    return { granted: true, delivered }
  }
  clearJoinRequest(spaceId, joinerKey)
  await markRequestDenied(spaceId, joinerKey)   // durable, replicated dismissal (+ drops our receipt)
  if (space.topic) {
    sendMembershipDeny(joinerKey, space.topic)
    broadcastMembershipCancel(spaceId, space.topic, joinerKey)   // co-members drop the banner
  }
  ipc.emit('event:join-requests-updated', { spaceId })
  return true
}

// Tear down a space we only ever sat pending in: no own drive, owned/foreign
// mounts, or authored membership records exist, so the heavyweight leave path
// (which purges a drive that was never materialized) does not apply and crashes
// on the closing cores. This is the cancel path for both a deny and a manual
// "stop waiting". Every step is best-effort so a single failure can't reject the
// caller and surface as an Uncaught in the renderer.
async function discardPendingSpace(spaceId) {
  markSpaceLeaving(spaceId)
  closeMemberView(spaceId)
  try {
    const space = await getSpace(spaceId)
    const peerMembers = (space?.members || []).filter((m) => !!m.driveKey)
    try { await leaveSpaceTopic(spaceId) } catch (err) { log.warn('discard pending: leave topic failed:', err.message) }
    try { await cleanupSpaceDrives(spaceId, peerMembers) } catch (err) { log.warn('discard pending: peer-drive cleanup failed:', err.message) }
    try { await purgeSpace(spaceId) } catch (err) { log.warn('discard pending: remove failed:', err.message) }
    dropSpaceDownloadRoot(spaceId)
    try { await forgetUnreferencedPeerCores(space?.members || []) } catch (err) { log.warn('discard pending: peer-core gc failed:', err.message) }
  } finally {
    unmarkSpaceLeaving(spaceId)
  }
}

// A peer handed us the space content key — the moment read access was actually granted, and the
// counterpart to the approver's own `membership.approved` row.
async function recordGrantReceived(spaceId, granterKey) {
  // One fresh read for all three fields: onGrant's own `space` was loaded before four awaits
  // (materializeOwnDrive, pinCreatorKey, broadcastProfileUpdate, openMemberView), and the roster
  // this needs is exactly what those may have just filled in.
  const space = await getSpace(spaceId)
  record('membership.granted', {
    actor: peerActorIn(space, granterKey || null),
    space: spaceRefOf(space),
    target: targetRef(TARGET_KIND.SPACE, spaceId, space?.name ?? null),
  })
}

// Registers the renderer-facing half and returns the two collaborators boot() needs.
export function createMembership(ipcRef, deps) {
  ipc = ipcRef
  log = deps.log
  dropSpaceDownloadRoot = deps.dropSpaceDownloadRoot

  ipc.handle('space:approve-member', async (msg) => {
    const space = await getSpace(msg.spaceId)
    // The real gate: approval IS handing out the content key, so a peer who holds no key
    // (pending, or otherwise unauthorized) physically cannot approve anyone — enforced by
    // the sck check inside resolveJoinRequest.
    if (!space || space.status === 'pending') return false
    const approved = await resolveJoinRequest(space, msg.publicKey, 'approve')
    if (approved) {
      record('membership.approved', {
        actor: selfActor(),
        space: spaceRefOf(space),
        target: targetRef(TARGET_KIND.MEMBER, msg.publicKey, peerActorIn(space, msg.publicKey).name),
      })
    }
    return approved
  })
  ipc.handle('space:deny-member', async (msg) => {
    const space = await getSpace(msg.spaceId)
    if (!space || space.status === 'pending') return false
    // Approval is monotonic: if another member already let them in (they hold the SCK),
    // a deny can't revoke without key rotation — clear our stale banner and no-op.
    if (await isApprovedMember(msg.spaceId, msg.publicKey)) {
      if (clearJoinRequest(msg.spaceId, msg.publicKey)) ipc.emit('event:join-requests-updated', { spaceId: msg.spaceId })
      return false
    }
    const denied = await resolveJoinRequest(space, msg.publicKey, 'deny')
    if (denied) {
      record('membership.denied', {
        actor: selfActor(),
        space: spaceRefOf(space),
        target: targetRef(TARGET_KIND.MEMBER, msg.publicKey, peerActorIn(space, msg.publicKey).name),
        outcome: OUTCOME.DENIED,
      })
    }
    return denied
  })
  ipc.handle('space:pending-requests', async (msg) => {
    const space = await getSpace(msg.spaceId)
    const memberKeys = new Set((space?.members || []).map(m => m.publicKey))
    return listPendingRequests(msg.spaceId, memberKeys)
  })

  return { memberRegistry, handleMembershipControl, discardPendingSpace }
}
