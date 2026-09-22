// The owner's half of share-wait: which inbound notices become a "waiting" row. A notice pins a row
// in our ledger, so every check that can refuse it runs before it lands: the sender is authenticated
// on this socket and is in the space it names, the strings are bounded, and the file is one of OURS
// whose hash we are still computing — a member cannot pin rows for arbitrary or already-hashed
// paths — and none of it runs while our own prepare-progress switch is off, so the feature is off at
// both ends together. Returns the verdict so the caller can log a drop. Pure: every collaborator is
// injected.
import { ARG_MAX } from '../contract/limits.js'

const bounded = (s, max) => typeof s === 'string' && s.length > 0 && s.length <= max

export const SHARE_WAIT_VERDICT = Object.freeze({
  MARKED: 'marked',
  CLEARED: 'cleared',
  DISABLED: 'disabled',
  UNAUTHORIZED: 'unauthorized',
  NOT_IN_SPACE: 'not-in-space',
  MALFORMED: 'malformed',
  NOT_OURS: 'not-ours',
  HASHED: 'hashed',
  CAPPED: 'capped',
  BUSY: 'busy',
  SUPERSEDED: 'superseded',
})

// markWaiting answers 'marked', 'capped' (the peer is at its cap) or 'busy' (the row is a live
// serve of another share's file under the same path).
export function createShareWaitIntake({ enabled = () => true, authorizedOn, inSpace, ownEntry, markWaiting, clearWaiting }) {
  // The catalog read makes a notice async while a cancel is not, so a cancel landing during that
  // read must win: the latest frame per (sender, file) is the only one allowed to apply.
  const latest = new Map()
  let seq = 0

  async function handle(socket, msg) {
    const { profileKey, spaceId, shareId, relPath } = msg
    if (!enabled()) return SHARE_WAIT_VERDICT.DISABLED
    if (typeof profileKey !== 'string' || !authorizedOn(socket, profileKey)) return SHARE_WAIT_VERDICT.UNAUTHORIZED
    if (typeof spaceId !== 'string' || !inSpace(profileKey, spaceId)) return SHARE_WAIT_VERDICT.NOT_IN_SPACE
    if (!bounded(shareId, ARG_MAX.key) || !bounded(relPath, ARG_MAX.path)) return SHARE_WAIT_VERDICT.MALFORMED
    const ref = { spaceId, shareId, relPath, from: profileKey }
    const key = [profileKey, spaceId, shareId, relPath].join('\0')
    const mine = ++seq
    if (msg.cancel === true) {
      latest.delete(key)
      clearWaiting(ref)
      return SHARE_WAIT_VERDICT.CLEARED
    }
    latest.set(key, mine)
    let entry = null
    try { entry = await ownEntry(spaceId, shareId, relPath) } catch { entry = null }
    if (latest.get(key) !== mine) return SHARE_WAIT_VERDICT.SUPERSEDED
    latest.delete(key)
    if (!entry) return SHARE_WAIT_VERDICT.NOT_OURS
    if (entry.contentHash) return SHARE_WAIT_VERDICT.HASHED
    const marked = markWaiting(ref)
    if (marked === 'marked') return SHARE_WAIT_VERDICT.MARKED
    return marked === 'busy' ? SHARE_WAIT_VERDICT.BUSY : SHARE_WAIT_VERDICT.CAPPED
  }

  return { handle, reset: () => latest.clear() }
}
