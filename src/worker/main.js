// Bare worker ENTRY — Mirall's data-layer process (see .claude/solution-architecture.md for the
// process model and glossary). This file runs once, top to bottom, and owns what only an entry
// can: the crash backstop and the pipe-close shutdown hooks (both installed before the first
// await), the bootstrap frame, the membership-control block, every renderer-facing IPC command
// handler (named `domain:verb`, grouped by the `// === … ===` section markers below), the
// shutdown deadline and Bare.exit.
//
// The data layer itself — Corestore, bees, migrations, folder subsystems, both swarms, the
// resume passes and the periodic backstops — is constructed and started by the composition root
// in ./boot.js, whose returned `root.close()` is the whole stop sequence. ipc.start() runs after
// every handler is registered, so no frame is dispatched before its handler exists.
import { PEER_FRAME } from '../shared/contract/peer-frames.js'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { createIPC, getBootstrapPromise } from '../shared/core/ipc.js'
import { createHealthMonitor } from '../shared/core/health.js'
import { registerSpaceLeave } from './ipc/space-leave.js'
import { registerAudit } from './ipc/audit.js'
import { registerNetwork } from './ipc/network.js'
import { registerSettings } from './ipc/settings.js'
import { registerProfile } from './ipc/profile.js'
import { registerFeedback } from './ipc/feedback.js'
import { registerDiagnostics } from './ipc/diagnostics.js'
import { registerFiles } from './ipc/files.js'
import { registerFolderPreview } from './ipc/folder-preview.js'
import { registerForeignFolders } from './ipc/foreign-folders.js'
import { registerOwnedFolders } from './ipc/owned-folders.js'
import { registerShares } from './ipc/shares.js'
import { createOwnedMounter } from './owned-mount.js'
import {
  setRuntimeConfig,
  isHandshakeIdentityBindingEnabled,
  getResourceCaps,
} from '../shared/core/runtime-config.js'
import { setSpaceDownloadRoot, forgetSpaceDownloadRoot, listDownloadRoots } from '../shared/core/paths.js'
import { createLogger } from '../shared/core/logger.js'
import { installCrashBackstop } from '../shared/core/crash-backstop.js'
import { WORKER_EXIT_UNSTABLE } from '../shared/contract/exit-codes.js'
import { MAIN_REQUEST_FRAME, MAIN_REQUEST } from '../shared/contract/main-requests.js'
import {
  getProfile,
  markOwnMembership,
  getLocalPublicKeyHex,
  readProfileRecord,
  markRequest,
  markRequestDenied,
  captureJoinerMembership,
  getIdentitySigner,
  markInvite,
} from '../shared/spaces/profile.js'
import {
  createSpace,
  joinSpace,
  listSpaces,
  getSpace,
  purgeSpace,
  updateSpace,
  toggleFavorite,
  upsertMember,
  getSpaceContentKey,
  recordJoinRequest,
  listJoinRequests,
  listPendingRequests,
  clearJoinRequest,
  recordApproval,
  materializeOwnDrive,
  pinCreatorKey,
  markCreatorDivergence,
  clearCreatorDivergence,
  clearPendingLeave,
  isLegacySpace,
  LEGACY_SPACE_MESSAGE,
} from '../shared/spaces/space.js'
import { classifyInvite } from '../shared/spaces/invite-policy.js'
import { encodeInvite, decodeInvite } from '../shared/contract/invite-envelope.js'
import {
  joinSpaceTopic,
  leaveSpaceTopic,
  cleanupSpaceDrives,
  getConnectedPeers,
  broadcastProfileUpdate,
  sendMembershipGrant,
  sendMembershipDeny,
  broadcastMembershipCancel,
  isApprovedMember,
  resolveInvite,
  markSpaceLeaving,
  unmarkSpaceLeaving,
  isSpaceLeaving,
  getBoundSignerKey,
  unregisterPendingLeave,
  leavePendingLeaveTopic,
  hasPendingLeave,
} from '../shared/transfer/swarm.js'
import { clampDisplayName, checkGrantAssertion } from '../shared/transfer/handshake-guard.js'
import { sanitizeAvatar } from '../shared/identity-limits.js'
import { openSealedSck } from '../shared/transfer/sck-seal.js'
import { reconcileAssertedRoot } from '../shared/spaces/creator-root.js'
import { getConnectedMemberMeta, readmitConnectedMembers } from '../shared/transfer/swarm.js'
import {
  openMemberView,
  closeMemberView,
  dropTombstone,
  isLeft,
  isApprovedJoiner,
  isDeniedJoiner,
} from '../shared/spaces/member-registry.js'
import { reconnectGrantAllowed } from '../shared/spaces/member-set.js'
import {
} from '../shared/transfer/files.js'
import {
} from '../shared/transfer/loose-overlay.js'

import { makeKeyedCoalescer } from '../shared/core/coalesce.js'
import { forgetUnreferencedPeerCores } from '../shared/storage/leftover.js'
import { record } from '../shared/audit/audit-log.js'
import { listMirrorsForShare, listMirrorsForSpace } from '../shared/folders/mirror-registry.js'
import { boot } from './boot.js'
import { AppError } from '../shared/core/errors.js'
import { CODES } from '../shared/contract/errors.js'
import { validateDownloadFolderAgainstMounts } from '../shared/folders/mount-validate.js'
import { OUTCOME, TARGET_KIND } from '../shared/contract/audit-kinds.js'
import { selfActor, peerActor, systemActor, targetRef } from '../shared/audit/audit-record.js'
import { refreshAuditSelfName, peerActorIn, spaceRefOf } from './audit-refs.js'

const ipc = createIPC(Bare.IPC)
const log = createLogger('worklet')

// Started next to ipc.start() rather than here: before the router goes live the loop is busy with
// boot I/O by design, and sampling that would report a wedge that is really just a large library
// being opened.
const health = createHealthMonitor()

// Main authorizes "reveal in folder" against these, and cannot read the space records
// that hold the per-space overrides, so the set is pushed to it on every change.
function publishDownloadRoots() {
  ipc.emit(MAIN_REQUEST_FRAME, { command: MAIN_REQUEST.DOWNLOADS_ROOTS, args: { roots: listDownloadRoots() } })
}

// Dropping a root is a NARROWING of that allowlist, so it has to be published like any other
// change: main's copy is push-only, and a forget that never republishes leaves it authorizing
// reveals under a departed space's folder for the rest of the process lifetime.
function dropSpaceDownloadRoot(spaceId) {
  forgetSpaceDownloadRoot(spaceId)
  publishDownloadRoots()
}

// === Crash safety & shutdown ===

// Installed FIRST — before any await — so a fire-and-forget rejection during boot (a background
// core open by discovery key hitting STORAGE_EMPTY, say) is logged instead of aborting the worker.
// Armed only once the worker is LIVE (`isArmed`): escalating during boot would recreate the abort
// this guard exists to prevent. `bootComplete` flips next to the ready broadcast, so the worker
// and the renderer's respawn policy agree on what "this generation booted" means.
installCrashBackstop(log, {
  isArmed: () => bootComplete && !shuttingDown,
  onUnstable: () => { safeShutdown('unstable', WORKER_EXIT_UNSTABLE) },
})

let root = null
let bootComplete = false
let shuttingDown = false
// `exitCode` is how the renderer tells an unstable exit from any other death. They want
// opposite respawn budgets and nothing else about the two exits differs.
async function safeShutdown(reason, exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  log.warn('shutdown:', reason)
  // Hard deadline: a hung swarm/store teardown must never keep the worker alive.
  // (This covers the "stuck on an await" case; if the event loop is starved by a
  // busy loop the timer can't fire either — the parent's SIGKILL backstop is what
  // reaps that case.)
  const deadline = setTimeout(() => { try { Bare.exit(exitCode) } catch {} }, 4000)
  deadline.unref?.()
  health.stop()
  // Before the data layer closes under them: a handler parked on a bee read that is about to be
  // closed throws a "session closed" error into the crash backstop's fault window, which exits the
  // worker once it fills. Aborted first, the same handler leaves through the ECANCELLED path the
  // router already treats as expected.
  ipc.abortAll('worker is shutting down')
  // The whole stop sequence — the departure announce, the flush window, then every subsystem in
  // the reverse of its start order — lives in the composition root. `root` is null until boot()
  // returns, which is what lets the pipe-close hooks below fire at any point during startup.
  try { await root?.close() } catch (err) { log.warn('shutdown: close failed:', err.message) }
  log.info('shutdown complete')
  Bare.exit(exitCode)
}

// Register the pipe-close teardown BEFORE the bootstrap await. If the parent dies
// during startup (before sending the bootstrap line), the IPC pipe closes while
// we're parked on getBootstrapPromise; without these handlers in place the
// worker would sit at that await forever as an idle orphan. safeShutdown's
// teardown steps all no-op safely when called before init.
Bare.IPC.on('end', () => { safeShutdown('ipc-end') })
Bare.IPC.on('close', () => { safeShutdown('ipc-close') })
Bare.IPC.on('error', (err) => { safeShutdown('ipc-error: ' + (err && err.message ? err.message : err)) })

// === Bootstrap frame ===

const bootstrap = await getBootstrapPromise()
setRuntimeConfig(bootstrap)

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

// === Membership control ===

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
  // We are still pending ourselves: we hold no content key, so we can neither grant
  // nor meaningfully approve — ignore other peers' requests entirely.
  if (space.status === 'pending') return
  // Capture the leave-tombstone (the kept "this peer left" marker) BEFORE clearing it: a peer
  // mid-leave can still be transiently in
  // space.members (handleLeaveFrame's removeMember hasn't committed), so a peer we've observed
  // leaving must go through fresh approval, never the reconnect re-grant shortcut below.
  const hadLeft = isLeft(spaceId, msg.profileKey)
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
  // Reconnect (still a member, no leave observed) → re-grant idempotently. A just-left peer falls
  // through to a fresh join request + approval banner instead.
  if (reconnectGrantAllowed((space.members || []).some((m) => m.publicKey === msg.profileKey), hadLeft)) return grant()
  // Approved but never confirmed: the durable approved/<S>/<joiner> receipt exists while the
  // joiner's own member/<S> record hasn't converged — the state a joiner approved while OFFLINE
  // re-knocks from (its grant frame was undeliverable, so it is still 'pending' and re-requests
  // on every reconnect). Re-issue the grant BEFORE the invite classification: the original invite
  // may be spent or expired by now and must not re-deny an already-approved joiner. Idempotent,
  // and self-terminating once the joiner publishes its member record and the fold promotes it;
  // hadLeft still forces a departed peer through fresh approval.
  if (!hadLeft && isApprovedJoiner(spaceId, msg.profileKey)) return grant()
  // Per-link policy. The record is replicated across the member set, so any member resolves it the
  // same: expired → refuse (the replicated record is authoritative, so stripping or forging the
  // envelope's expiry hint cannot bypass it); auto → grant; review/absent → fall through to the
  // manual approval banner. A resolved record (inviteRec) marks a deliberate, still-valid link.
  let inviteRec = null
  if (msg.inviteId) {
    inviteRec = await resolveInvite(space, msg.inviteId)
    const verdict = classifyInvite(inviteRec)
    if (verdict === 'expired') {
      if (space.topic) sendMembershipDeny(msg.profileKey, space.topic)
      return
    }
    if (verdict === 'auto') {
      await resolveJoinRequest(space, msg.profileKey, 'approve')
      return
    }
  }
  // Denied while offline: the durable denied/<S>/<joiner> tombstone converged among members, but
  // the joiner never received the live deny frame — its space is stuck 'pending' and re-knocks on
  // every reconnect. Re-send the deny so a STUCK joiner (a bare reconnect replay: no currently-valid
  // reviewable invite backs this knock) can discard the space; no fresh banner. But a valid review
  // invite means the owner re-opened the door — fall through to the banner so they can approve or
  // revoke, instead of silently re-denying a genuine re-invitation.
  if (!hadLeft && !inviteRec && isDeniedJoiner(spaceId, msg.profileKey)) {
    if (space.topic) sendMembershipDeny(msg.profileKey, space.topic)
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

// === Boot: the composition root constructs and starts the data layer ===
//
// Everything from the Corestore to the swarm lives in src/worker/boot.js, which starts each
// subsystem in a declared order and closes them in reverse. What stays here is what only an
// entry can own: the pipe, the handlers, the deadline and Bare.exit.

// The root constructs everything it needs; handleMembershipControl, publishDownloadRoots and the
// member-registry collaborators are passed in because they close over state that belongs here.
root = await boot(bootstrap, {
  ipc,
  log,
  membershipControl: handleMembershipControl,
  publishDownloadRoots,
  memberRegistry,
  // Publishes a closable handle before the root finishes starting, so a pipe close or a quit
  // during boot still announces departure and drops what came up. The full root replaces it on
  // the line below; both carry the same close().
  onPartialRoot: (partial) => { root = partial },
})
const { mounts, intents, applyRelayConfig } = root
const mountOwnedShare = createOwnedMounter({ ipc, mounts })

ipc.handle('shutdown', () => { safeShutdown('renderer-shutdown') })

// === IPC: folder-share handlers (shares, owned & foreign mounts) ===

registerShares(ipc, { log, intents, mountOwnedShare })

registerFolderPreview(ipc)

registerOwnedFolders(ipc, { log, mounts, intents, mountOwnedShare })

registerForeignFolders(ipc, { log, intents })

// === IPC: profile & space handlers ===

registerProfile(ipc, { log })

// The self-first roster (avatars included) for ONE space. Rosters ship slim in spaces:list —
// avatars are base64 data-URLs up to the sanitizeAvatar cap, far too heavy for an
// every-refetch payload — so per-space consumers read this on demand.
function fullRoster(space, profile) {
  const others = (space.members || []).filter((m) => !profile || m.publicKey !== profile.publicKey)
  if (!profile) return others
  const self = {
    publicKey: profile.publicKey,
    driveKey: null,
    displayName: profile.displayName,
    avatar: profile.avatar,
  }
  return [self, ...others]
}

// The catalog-key fields are worker-internal (handshake fallbacks) — no roster payload
// ships them to the renderer.
function stripCatalogKeys({ looseCatalogKey, looseCatalogKeyEnc, ...m }) {
  return m
}

function slimMember(m) {
  const { avatar, ...slim } = stripCatalogKeys(m)
  return slim
}

// The one projection for every Space[] the worker ships (spaces:list AND the boot
// event:state) — slim self-first rosters plus memberCount/pendingCount. A second
// unprojected emit path would leak raw rosters and desync the renderer's Space type.
async function slimSpaces(profile) {
  // A space mid-leave (or one whose interrupted-leave completion failed at boot) must not
  // surface as a normal space: it has no drive, no swarm, and is about to be forgotten.
  const allSpaces = (await listSpaces()).filter((s) => !s.leaving)
  return allSpaces.map(s => {
    const memberKeys = new Set((s.members || []).map(m => m.publicKey))
    if (profile) memberKeys.add(profile.publicKey)
    const members = fullRoster(s, profile).map(slimMember)
    return {
      ...s,
      members,
      memberCount: members.length,
      pendingCount: listPendingRequests(s.spaceId, memberKeys).length,
    }
  })
}

ipc.handle('spaces:list', async () => slimSpaces(await getProfile()))

ipc.handle('space:members', async (msg) => {
  const space = await getSpace(msg.spaceId)
  if (!space || space.leaving) return []
  return fullRoster(space, await getProfile()).map(stripCatalogKeys)
})
ipc.handle('space:mirrors', async (msg) => {
  const mirrors = msg.shareId
    ? await listMirrorsForShare(msg.spaceId, msg.shareId)
    : await listMirrorsForSpace(msg.spaceId)
  return mirrors.map((m) => ({ mirrorer: m.mirrorer, shareId: m.shareId, state: m.state, mountedAt: m.mountedAt }))
})
ipc.handle('space:create', async (msg) => {
  log.info('creating space:', msg.name)
  const space = await createSpace(msg.name, msg.icon)
  await markOwnMembership(space.spaceId, { refresh: true })
  await joinSpaceTopic(space.spaceId)
  await openMemberView(space.spaceId)   // the creator's own space derives its membership too
  log.info('space created:', space.spaceId)
  record('space.created', {
    actor: selfActor(),
    space: spaceRefOf(space),
    target: targetRef(TARGET_KIND.SPACE, space.spaceId, space.name),
  })
  return space
})
// Block a rejoin until a concurrent leave of the same space has fully torn down (the leaving flag
// clears only after the catalog record + drive are purged), so the rejoin sees no stale record and
// mints a fresh driveSuffix instead of resurrecting the just-purged deterministic drive key.
async function awaitSpaceLeaveSettled(spaceId, capMs = 15000) {
  if (!isSpaceLeaving(spaceId)) return true
  log.info('join: waiting for in-progress leave to settle:', spaceId)
  const start = Date.now()
  while (isSpaceLeaving(spaceId) && Date.now() - start < capMs) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  return !isSpaceLeaving(spaceId)
}
ipc.handle('space:join', async (msg) => {
  const decoded = decodeInvite(msg.inviteCode)
  if (!decoded) {
    throw new AppError(CODES.INVITE_INVALID, 'Invalid invite code')
  }
  // Soft pre-check for instant feedback. `x` is a strippable hint, so allow 60s for clock skew;
  // the minting member's record is the authority on the handshake.
  if (decoded.expiresAt && decoded.expiresAt + 60_000 < Date.now()) {
    throw new AppError(CODES.INVITE_EXPIRED, 'This invite link has expired')
  }
  const name = (typeof msg.name === 'string' && msg.name.trim()) || decoded.name || 'Shared Space'
  // Rejoining a space we just left: wait for the leave teardown to settle. While it runs the
  // catalog record still holds the old driveSuffix, and joinSpace would reuse it — resurrecting
  // the deterministic drive key and forking replication against the blocks co-members still hold
  // (the INVALID_OPERATION "Nodes is out of bounds" reconnect loop). Once leaving clears, the
  // record is gone, so the rejoin mints a fresh suffix → a genuinely new, fork-free drive. If the
  // teardown is still running past the cap, refuse the join rather than fork — the user retries.
  if (!(await awaitSpaceLeaveSettled(decoded.topic.slice(0, 16)))) {
    throw new AppError(CODES.LEAVE_IN_PROGRESS, 'A leave of this space is still finishing — try joining again in a moment')
  }
  const rejoinSpaceId = decoded.topic.slice(0, 16)
  log.info('joining space', decoded.v === 1 ? '(envelope)' : '(legacy)')
  const space = await joinSpace(decoded.topic, name, msg.icon, { inviteId: decoded.inviteId, creator: decoded.creator })
  await markOwnMembership(space.spaceId, { refresh: true })
  // A genuine rejoin supersedes any pending outbound leave: the fresh member/<S> record (strictly
  // newer ts) outranks the old tombstone on co-members, so retire the marker + its replay topic.
  // Guard on an ACTIVE marker (never touch the shared topic maps otherwise — re-pasting an invite
  // for a space we already belong to reaches here with no marker, and an unguarded
  // leavePendingLeaveTopic would tear down that LIVE space's topic), and only after the rejoin is
  // durable so a joinSpace failure can't drop a still-needed replay. joinSpaceTopic below re-joins.
  if (hasPendingLeave(rejoinSpaceId)) {
    unregisterPendingLeave(rejoinSpaceId)
    await clearPendingLeave(rejoinSpaceId)
    await leavePendingLeaveTopic(rejoinSpaceId)
  }
  // Pre-seed the inviter as an offline shell member (when the envelope carries
  // their identity) so the space isn't empty until their handshake lands. Keyed
  // by their real public key, so the handshake's upsertMember merges into this
  // entry — filling driveKey/avatar and flipping them online — rather than adding
  // a duplicate. Skipped if the invite predates this field or names ourselves.
  if (decoded.owner && decoded.owner !== getLocalPublicKeyHex()) {
    await upsertMember(space.spaceId, {
      publicKey: decoded.owner,
      displayName: decoded.ownerName || 'Unknown',
    })
  }
  await joinSpaceTopic(space.spaceId)
  await openMemberView(space.spaceId)   // no-op while pending; opens on re-join of an approved space
  log.info('space joined:', space.spaceId)
  record('space.joined', {
    actor: selfActor(),
    space: spaceRefOf(space),
    target: targetRef(TARGET_KIND.SPACE, space.spaceId, space.name),
    subject: { inviteId: decoded.inviteId || null, autoAdmit: !!decoded.autoAdmit },
  })
  return space
})
ipc.handle('space:invite', async (msg) => {
  const space = await getSpace(msg.spaceId)
  // Throw rather than return null: a null resolves as success and the modal re-enables its button
  // with no code and no reason on screen.
  if (!space?.topic) throw new AppError(CODES.SPACE_NOT_FOUND, 'Space not found')
  // Hard block: a member-only capability. While pending we hold no content key, so
  // any invite we minted could never confer read access (the redeemer would stall
  // pending exactly as we do) — but it WOULD leak the space topic to outsiders. Refuse
  // at the data layer, not just in the UI, so membership is enforced where it's authored.
  if (space.status === 'pending') {
    throw new AppError(CODES.NOT_A_MEMBER, 'Cannot invite to a space you have not joined')
  }
  // We hold no SCK for a pre-encryption space, so nobody redeeming this link could ever be
  // approved — the joiner would mint a v2 pending record (legacy on OUR side, not theirs) and
  // wait forever with no way to learn why.
  if (isLegacySpace(space)) throw new AppError(CODES.SPACE_UNSUPPORTED, LEGACY_SPACE_MESSAGE)
  // Embed our identity so the joiner can show us as an offline member before we
  // first connect. Display name is a snapshot at invite time; the handshake later
  // corrects it if we've since renamed.
  const profile = await getProfile()
  // Mint a replicated per-link record when the caller asks for auto-approve OR an expiry — the
  // new UI always sends an expiry. A bare programmatic call (no opts) stays record-less = a
  // plain manual, never-expiring invite.
  let inviteId, expiresAt
  if (msg.autoAdmit || Number.isInteger(msg.expiresInMs)) {
    inviteId = b4a.toString(crypto.randomBytes(16), 'hex')
    expiresAt = Number.isInteger(msg.expiresInMs) ? Date.now() + msg.expiresInMs : null
    await markInvite(space.spaceId, inviteId, { autoApprove: !!msg.autoAdmit, expiresAt })
    record('invite.minted', {
      actor: selfActor(),
      space: spaceRefOf(space),
      target: targetRef(TARGET_KIND.INVITE, inviteId, null),
      subject: { autoAdmit: !!msg.autoAdmit, expiresAt },
    })
  }
  return encodeInvite({
    topic: space.topic,
    name: space.name,
    owner: profile?.publicKey,
    ownerName: profile?.displayName,
    // The OR-Set root (whoever created the space), so every joiner — and every member
    // who re-shares this invite — seeds its membership fold from the same peer. Distinct
    // from `owner` above, which is us (the inviter). Absent on pre-creatorKey joined
    // spaces; the fold's transition fallback covers those.
    creator: space.creatorKey,
    schemaVersion: 2,
    autoAdmit: !!(inviteId && msg.autoAdmit),
    inviteId,
    expiresAt,
  })
})
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
ipc.handle('space:update', async (msg) => {
  const space = await getSpace(msg.spaceId)
  if (space?.status === 'pending') return null
  log.info('updating space:', msg.spaceId)
  // Tri-state: absent leaves the override alone, null clears it, a string is validated.
  let downloadFolder
  if (msg.downloadFolder !== undefined) {
    downloadFolder = msg.downloadFolder === null
      ? null
      : await validateDownloadFolderAgainstMounts(msg.downloadFolder)
  }
  const updated = await updateSpace(msg.spaceId, msg.name, msg.icon, { downloadFolder })
  if (updated) {
    if (downloadFolder !== undefined) {
      setSpaceDownloadRoot(msg.spaceId, downloadFolder)
      publishDownloadRoots()
      // Every row's downloaded status derives from the root, so re-derive the file views.
      ipc.emit('event:files-updated', { spaceId: msg.spaceId })
    }
    record('space.updated', {
      actor: selfActor(),
      space: spaceRefOf(updated),
      target: targetRef(TARGET_KIND.SPACE, msg.spaceId, updated.name),
      subject: { previousName: space?.name ?? null },
    })
  }
  return updated
})
ipc.handle('space:toggle-favorite', async (msg) => {
  return await toggleFavorite(msg.spaceId)
})
registerSpaceLeave(ipc, { log, mounts, discardPendingSpace, dropSpaceDownloadRoot })

// === IPC: presence, file & transfer handlers ===

ipc.handle('members:online', async (msg) => {
  // Include self: the local peer never leases itself in presence, and every consumer
  // wants "who is reachable INCLUDING me".
  return [getLocalPublicKeyHex(), ...getConnectedPeers(msg.spaceId)]
})

registerFiles(ipc, { log })

// === IPC: feedback, storage & settings handlers ===

registerSettings(ipc, { mounts, publishDownloadRoots })
registerFeedback(ipc)
registerNetwork(ipc, { applyRelayConfig })
registerDiagnostics(ipc, { health, getRoot: () => root })

ipc.handle('ping', async () => ({ pong: true, timestamp: Date.now() }))

// === IPC: audit log ===

registerAudit(ipc)

// === Go live: flush queued frames, announce ready ===

health.start()
ipc.start()

ipc.emit('event:worker-ready')

log.info('ready')
// From here a fault storm is the worker's own failure, not a boot that has not finished, so the
// backstop may escalate. Set after the ready broadcast so the renderer has already recorded this
// generation as booted before any escalation can end it.
bootComplete = true

const profile = await getProfile()
refreshAuditSelfName(profile?.displayName)
if (!profile) {
  ipc.emit('event:profile-needed')
} else {
  ipc.emit('event:state', { profile, spaces: await slimSpaces(profile) })
}
