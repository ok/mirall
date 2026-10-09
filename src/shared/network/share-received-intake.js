// The owner's half of share-received: which inbound notices become a file recipient. A notice is a
// member's claim, so it lands only when the sender is authenticated on this socket and in the space
// it names, the strings are bounded, and the file is one of OURS at exactly the hash claimed — a
// member cannot list itself against a file we do not share or a version we no longer advertise.
// Pure: every collaborator is injected.
import { ARG_MAX } from '../contract/limits.js'

const bounded = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max

export const SHARE_RECEIVED_VERDICT = Object.freeze({
  RECORDED: 'recorded',
  UNAUTHORIZED: 'unauthorized',
  NOT_IN_SPACE: 'not-in-space',
  MALFORMED: 'malformed',
  NOT_OURS: 'not-ours',
  STALE: 'stale',
})

export function createShareReceivedIntake({ authorizedOn, inSpace, ownEntry, noteRecipient }) {
  async function handle(socket, msg) {
    const { profileKey, spaceId, shareId, relPath, contentHash } = msg
    if (typeof profileKey !== 'string' || !authorizedOn(socket, profileKey)) return SHARE_RECEIVED_VERDICT.UNAUTHORIZED
    if (typeof spaceId !== 'string' || !inSpace(profileKey, spaceId)) return SHARE_RECEIVED_VERDICT.NOT_IN_SPACE
    if (!bounded(shareId, ARG_MAX.key) || !bounded(relPath, ARG_MAX.path) || !bounded(contentHash, ARG_MAX.key)) {
      return SHARE_RECEIVED_VERDICT.MALFORMED
    }
    let entry = null
    try { entry = await ownEntry(spaceId, shareId, relPath) } catch { entry = null }
    if (!entry) return SHARE_RECEIVED_VERDICT.NOT_OURS
    if (entry.contentHash !== contentHash) return SHARE_RECEIVED_VERDICT.STALE
    await noteRecipient({ spaceId, shareId, relPath, contentHash, personKey: profileKey, size: entry.size ?? null })
    return SHARE_RECEIVED_VERDICT.RECORDED
  }

  return { handle }
}
