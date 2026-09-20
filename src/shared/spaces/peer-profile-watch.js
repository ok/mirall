// The one held profile-bee session per peer, and the avatar read that depends on it.
//
// A peer's profile bee is a live Hyperbee session with an append listener: holding one per peer is
// what turns a co-member's later profile edit into a local update without a poll. The session is
// the reason this is a module and not a helper — it has to be closed, and closed once.

import { openProfileBee } from './profile.js'
import { upsertMember } from './space.js'
import { observePeerProfile } from '../audit/peer-records-watch.js'
import { reconcilePendingRequestersForApprover, emitPeerSharesUpdated } from '../network/deferred-admission.js'
import { sanitizeAvatar } from '../contract/identity-limits.js'
import { getMembershipCaps } from '../core/runtime-config.js'
import b4a from 'b4a'
import { createLogger } from '../core/logger.js'

const log = createLogger('peer-profile-watch')

// profileKey hex → { bee, listener } — the ONE held bee per peer
const profileBeeAppendListeners = new Map()

// connectedPeers is the swarm's own registry, not a copy: an avatar read resolves the member it
// belongs to through the same routing table the connection lives in.
let getIpc = () => null
let connectedPeers = new Map()

export function initPeerProfileWatch(deps) {
  getIpc = deps.getIpc
  connectedPeers = deps.connectedPeers
}

// The avatar value lives in the peer's profile bee. At handshake time that block may
// not have replicated yet, and a churning ("space-jump") connection can drop before it
// arrives — the pending block read then rejects with BLOCK_NOT_AVAILABLE instead of
// completing. It is transient: the block lands once the connection stabilizes (or on a
// reconnect), so retry a few times before giving up rather than leaving the member as
// initials. A genuinely unset avatar (null) is not retried.
const AVATAR_FETCH_ATTEMPTS = 4
const AVATAR_RETRY_BASE_MS = 1500

function isBlockUnavailable(err) {
  return err?.code === 'BLOCK_NOT_AVAILABLE' || /not available|avatar sync timeout/i.test(err?.message || '')
}

// The long-lived holder: ONE bee per peer for the process lifetime, carrying the append listener
// that drives admission re-evaluation, the share-list refresh and the audit observer. Every other
// touch of a peer's bee is a bounded read that opens and closes its own session (withPeerBee).
function ensurePeerProfileWatch(personKey, profileKeyHex) {
  const held = profileBeeAppendListeners.get(personKey)
  if (held) return held
  const peerProfileBee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
  {
    const listener = () => {
      // The append may be a new approved/<space>/<joiner> record — re-evaluate any
      // join request we hold for a peer this member may have just approved. (The fold's
      // own watchers handle member-set re-derivation; this only drives admission.)
      reconcilePendingRequestersForApprover(personKey).catch(err => {
        log.warn('approval-driven admit failed:', err.message)
      })
      // …or a new/removed `share/<space>/*` record (shares live in the peer's profile bee).
      // This is the only peer-side trigger that refreshes the share LIST — the drive-append
      // listener only covers files.
      emitPeerSharesUpdated(personKey).catch(err => {
        log.warn('peer shares-updated emit failed:', err.message)
      })
      // The same append is the only signal that a peer created/deleted a folder share or started
      // mirroring one of ours. This hook is coarse — it fires for ANY bee change — so the
      // observer diffs the bee's own history rather than trusting the poke.
      observePeerProfile(personKey, peerProfileBee)
    }
    peerProfileBee.core.on('append', listener)
    profileBeeAppendListeners.set(personKey, { bee: peerProfileBee, listener })
    // Baseline now, not on the first append — otherwise the first share a peer creates after we
    // meet them is swallowed as "history".
    // Drop the entry if the bee never opens: a cached broken holder would make every later avatar
    // fetch for this peer fail for the process lifetime.
    peerProfileBee.ready().then(
      () => observePeerProfile(personKey, peerProfileBee, { baselineOnly: true }),
      (err) => {
        log.warn('peer profile bee failed to open — dropping the watch so the next handshake retries:', err.message)
        if (profileBeeAppendListeners.get(personKey)?.bee === peerProfileBee) profileBeeAppendListeners.delete(personKey)
        try { peerProfileBee.core.off('append', listener) } catch {}
        peerProfileBee.close().catch(() => {})
      },
    )
  }
  return profileBeeAppendListeners.get(personKey)
}

export async function fetchPeerAvatar(personKey, msg, spaceId, space) {
  const { bee: peerProfileBee } = ensurePeerProfileWatch(personKey, msg.profileKey)
  await peerProfileBee.ready()

  for (let attempt = 0; attempt < AVATAR_FETCH_ATTEMPTS; attempt++) {
    try {
      await Promise.race([
        peerProfileBee.core.update({ wait: true }),
        new Promise((_, reject) => setTimeout(() => reject(new Error('avatar sync timeout')), 10000)),
      ])
      const avatarEntry = await peerProfileBee.get('avatar')
      const peerAvatar = sanitizeAvatar(avatarEntry?.value || null, getMembershipCaps().maxAvatarBytes)
      if (!peerAvatar) return

      const peerEntry = connectedPeers.get(personKey)
      if (peerEntry) peerEntry.avatar = peerAvatar

      // Persist avatar to space members (atomic merge — won't clobber a concurrent
      // membership write, and no-ops if the avatar is unchanged or the member is gone).
      if (space) {
        await upsertMember(spaceId, { publicKey: personKey, avatar: peerAvatar }, { create: false })
      }

      getIpc().emit('event:member-avatar-updated', { spaceId, publicKey: personKey, avatar: peerAvatar })
      return
    } catch (err) {
      if (!isBlockUnavailable(err) || attempt === AVATAR_FETCH_ATTEMPTS - 1) {
        log.debug('avatar not available yet for', msg.displayName, '-', err.message)
        return
      }
      await new Promise((r) => setTimeout(r, AVATAR_RETRY_BASE_MS * (attempt + 1)))
    }
  }
}

// Closes every held session. Each carries a live bee and an append listener, so dropping the map
// alone would leak both.
export function resetPeerProfileWatch() {
  for (const held of profileBeeAppendListeners.values()) {
    try { held.bee.core.off('append', held.listener) } catch {}
    held.bee.close().catch(() => {})
  }
  profileBeeAppendListeners.clear()
}
