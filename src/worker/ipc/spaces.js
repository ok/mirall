// Spaces: create, join, invite, update, and the per-space reads the renderer polls. space:leave
// is its own module — its teardown order is shared with boot's interrupted-leave pass.

import { AppError } from '../../shared/core/errors.js'
import { CODES } from '../../shared/contract/errors.js'
import { TARGET_KIND } from '../../shared/contract/audit-kinds.js'
import { encodeInvite, decodeInvite } from '../../shared/contract/invite-envelope.js'
import { getProfile, getLocalPublicKeyHex, markInvite, markOwnMembership } from '../../shared/spaces/profile.js'
import {
  getSpace,
  updateSpace,
  toggleFavorite,
  isLegacySpace,
  LEGACY_SPACE_MESSAGE,
  upsertMember,
} from '../../shared/spaces/space.js'
import { createSpace, joinSpace } from '../../shared/spaces/space-lifecycle.js'
import { clearPendingLeave } from '../../shared/spaces/leave-records.js'
import {
  getConnectedPeers,
  isSpaceLeaving,
  joinSpaceTopic,
  hasPendingLeave,
  unregisterPendingLeave,
  leavePendingLeaveTopic,
} from '../../shared/network/swarm.js'
import { listMirrorsForShare, listMirrorsForSpace } from '../../shared/folders/mirror-registry.js'
import { setSpaceDownloadRoot } from '../../shared/core/paths.js'
import { validateDownloadFolderAgainstMounts } from '../../shared/folders/mount-validate.js'
import { record } from '../../shared/audit/audit-log.js'
import { selfActor, targetRef } from '../../shared/audit/audit-record.js'
import { spaceRefOf } from '../audit-refs.js'
import { fullRoster, stripCatalogKeys, slimSpaces } from '../space-projection.js'

import { openMemberView } from '../../shared/spaces/member-registry.js'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

export function registerSpaces(ipc, { log, publishDownloadRoots }) {
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

  ipc.handle('members:online', async (msg) => {
    // Include self: the local peer never leases itself in presence, and every consumer
    // wants "who is reachable INCLUDING me".
    return [getLocalPublicKeyHex(), ...getConnectedPeers(msg.spaceId)]
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
}
