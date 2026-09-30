// A refused serve becomes one `security.serve_denied` audit row per (requester, hash) per window.
// The audit log never goes on the wire, so recording a denial leaves it indistinguishable from
// "not held" to the requester. Recording never throws into the serve gate.
import { RESOLVE_OUTCOME, recordResolved } from '../../../audit/audit-log.js'
import { getSpace } from '../../../spaces/space.js'
import { serveIndex } from './overlay-serve-index.js'
import { OUTCOME, TARGET_KIND } from '../../../contract/audit-kinds.js'
import { peerActor, targetRef } from '../../../audit/audit-record.js'

// Repeats collapse: a peer that keeps retrying the same hash is one incident, not twenty. The
// window is in-memory because a burst is a within-session phenomenon; across a restart the first
// retry legitimately re-reports.
const DENIAL_WINDOW_MS = 3600000
// Above this many tracked (peer, hash) pairs, entries whose window has lapsed are pruned.
const MAX_TRACKED = 500
const deniedRecently = new Map()

// A refusal row has to say WHAT was refused and BY WHOM, or it reads as "A file request was
// refused" with a blank avatar and tells the reader nothing. Both are best-effort: a denied peer
// is often not a member of any space we share (that is why it was denied), and a hash we do not
// hold has no name here — in which case the row falls back to a short key rather than nothing.
/** @internal */
export function recordServeDenial(reason, { from, contentHash }) {
  const key = (from || '') + '\0' + (contentHash || '')
  const now = Date.now()
  const last = deniedRecently.get(key)
  if (last && now - last < DENIAL_WINDOW_MS) return
  deniedRecently.set(key, now)
  if (deniedRecently.size > MAX_TRACKED) {
    for (const [k, ts] of deniedRecently) if (now - ts >= DENIAL_WINDOW_MS) deniedRecently.delete(k)
  }

  const requester = from ? from.slice(0, 12) : null
  return recordResolved('security.serve_denied', async () => {
    const spaceId = [...serveIndex.spacesFor(contentHash)][0] || null
    const refs = serveIndex.refsFor ? serveIndex.refsFor(contentHash) : []
    const relPath = refs[0]?.relPath || null
    const space = spaceId ? await getSpace(spaceId) : null
    return {
      actor: peerActor(from || null, (space?.members || []).find((m) => m.publicKey === from)?.displayName || null),
      space: space ? { id: space.spaceId, name: space.name ?? null } : null,
      target: targetRef(TARGET_KIND.FILE, contentHash || null, relPath ? relPath.split('/').pop() : null),
      subject: { reason, requester },
      outcome: OUTCOME.DENIED,
    }
  }, { context: { reason, requester } }).then((outcome) => {
    // A lost row leaves no dedupe mark, so the next attempt can still record it.
    if (outcome === RESOLVE_OUTCOME.LOST) deniedRecently.delete(key)
  })
}

export function resetServeDenialAudit() {
  deniedRecently.clear()
}
