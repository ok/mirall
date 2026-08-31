// The admission gates: may this peer join this space, and on whose authority. Two questions the
// handshake asks before it registers anyone — approval (does any member vouch for them?) and the
// creator root (do we and they agree on who founded the space?).
//
// Extracted from swarm.js. A factory over two collaborators rather than free functions: `connectedPeers`
// is swarm.js's registry and `log` is its named logger, and taking them explicitly is what keeps this
// module free of the swarm's module state.
import { getLocalPublicKeyHex, readPeerApproval, hasOwnApproval, readOwnInvite, readPeerInvite, readPeerInviteSnapshot, revokeInvite } from '../spaces/profile.js'
import { getSpace, recordJoinRequest, pinCreatorKey, markCreatorDivergence, clearCreatorDivergence } from '../spaces/space.js'
import { isHandshakeIdentityBindingEnabled } from '../core/runtime-config.js'
import { reconcileAssertedRoot } from '../spaces/creator-root.js'
import { snapshotCandidates } from '../spaces/invite-policy.js'
import { isLeft, openMemberView, closeMemberView } from '../spaces/member-registry.js'

export function createAdmissionGates({ connectedPeers, log }) {
  // A v2 peer is admitted if we already hold them as a member, or any member we know has an
  // authored `approved/<S>/<joiner>` record for them (an approval by one member propagates
  // via replication — no gossip). This is the read gate; the derived set governs the list.
  async function isApprovedByPeers(space, joinerKey) {
    const me = getLocalPublicKeyHex()
    // Our OWN approval counts — without this the owner can't admit a peer it approved itself once the
    // upserted member is dropped by a fold that hasn't read the joiner's (not-yet-replicated) // leaving the joiner stuck as a pending request on the very peer that approved them.
    if (await hasOwnApproval(space.spaceId, joinerKey)) return true
    for (const m of space.members || []) {
      if (m.publicKey === joinerKey || m.publicKey === me) continue
      if (await readPeerApproval(m.publicKey, space.spaceId, joinerKey)) return true
    }
    return false
  }

  async function isApprovedMember(spaceId, joinerKey) {
    const space = await getSpace(spaceId)
    if (!space) return false
    if ((space.members || []).some((m) => m.publicKey === joinerKey)) return true
    return await isApprovedByPeers(space, joinerKey)
  }

  // Resolve a link's per-link record from anywhere in the member set: our own bee first (the minter
  // resolving its own join), then every co-member's replicated bee (read concurrently — an offline
  // member costs a full read budget, and a space's worth of them must not stack on the join path),
  // then the local contiguous snapshot of any member that is genuinely OFFLINE.
  //
  // The snapshot is gated on the author having no live connection, not merely on the read failing:
  // a read that TIMES OUT against a connected peer says nothing about the record, and trusting a
  // stale prefix there would auto-admit a link that peer has since revoked. Offline + a captured
  // prefix is the only case we answer from local state; a connected-but-silent minter falls through
  // to manual approval, as before. Prunes our own expired record.
  async function resolveInvite(space, inviteId) {
    if (!inviteId) return null
    const me = getLocalPublicKeyHex()
    const own = await readOwnInvite(space.spaceId, inviteId)
    if (own) {
      if (own.expiresAt && own.expiresAt < Date.now()) {
        await revokeInvite(space.spaceId, inviteId)
        return { ...own, expired: true }
      }
      return own
    }
    const peers = (space.members || []).filter((m) => m.publicKey !== me).map((m) => m.publicKey)
    const live = await Promise.all(peers.map((key) => readPeerInvite(key, space.spaceId, inviteId)))
    for (const rec of live) {
      if (rec?.resolved && rec.value) return rec.value   // an authoritative live read wins outright
    }
    for (const key of snapshotCandidates(peers, live, (k) => connectedPeers.has(k))) {
      const snap = await readPeerInviteSnapshot(key, space.spaceId, inviteId)
      if (snap) return { ...snap, stale: true }
    }
    return null
  }

  // Reconcile a connected member's authenticated creator-root assertion against our pin. Adopt
  // (corrects a poisoned TOFU — trust-on-first-use — pin) or confirm (clears the unverified flag)
  // when ours is provisional; refuse (surface divergence, keep our pin) when ours is already
  // confirmed. A pin whose KEY actually changes must re-fold the live member view off the
  // corrected root.
  async function crossCheckCreatorRoot(spaceId, space, asserted) {
    const decision = reconcileAssertedRoot({
      pinned: space.creatorKey,
      pinnedIsAuthenticated: !space.creatorUnverified,
      asserted,
    })
    if (decision === 'noop') {
      // An authenticated peer re-asserted the pinned root — the conflict is no longer live. Emit so
      // an open view re-derives and drops the banner, mirroring the set path below.
      if (space.creatorDivergence) {
        await clearCreatorDivergence(spaceId)
        ipcRef.emit('event:membership-creator-divergence', { spaceId })
      }
      return
    }
    if (decision === 'refuse') {
      log.warn('handshake creator divergence — confirmed', space.creatorKey.slice(0, 12) + '...', 'vs peer', asserted.slice(0, 12) + '...')
      await markCreatorDivergence(spaceId)
      ipcRef.emit('event:membership-creator-divergence', { spaceId })
      return
    }
    const keyChanged = space.creatorKey !== asserted
    await pinCreatorKey(spaceId, asserted)
    if (keyChanged) {
      closeMemberView(spaceId)
      await openMemberView(spaceId)
    }
  }

  // The read gate. Returns true if the peer is admitted — a recognized member, or one a co-member
  // approved (admitted via the APPROVAL record in the approver's already-replicated bee, not the
  // joiner's own record, which isn't replicated to us until admission). When admitted with the
  // identity binding enforced, its authenticated creator root is cross-checked. Returns false
  // (handshake must STOP, drive never opened) for a peer we just saw leave, or an unapproved one
  // — which we record as a converging join request: it already holds a drive (so it was approved
  // by SOME member), but we raise no approve banner, since under replication lag that would let a
  // co-member "re-approve" a peer who already joined. (Genuine no-drive joiners come through
  // onJoinRequest, which still does.)
  async function admitMember(spaceId, space, msg) {
    // A peer we just saw leave: ignore lingering handshakes (the connection often outlives the leave
    // frame during teardown). Cleared when they send a fresh join request.
    if (isLeft(spaceId, msg.profileKey)) return false
    const known = !!(space.members || []).find((m) => m.publicKey === msg.profileKey)
    if (!known && !(await isApprovedByPeers(space, msg.profileKey))) {
      recordJoinRequest(spaceId, msg.profileKey, msg.displayName, null, msg.driveKey || null)
      return false
    }
    // Confirm a provisional pin against the now-authenticated asserted root, or surface
    // divergence against a confirmed one.
    if (space.creatorKey && typeof msg.creator === 'string' && isHandshakeIdentityBindingEnabled()) {
      await crossCheckCreatorRoot(spaceId, space, msg.creator)
    }
    return true
  }

  return { isApprovedMember, resolveInvite, admitMember }
}
