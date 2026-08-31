// A folder share's live scan status: how many of its files are still queued or being hashed.
//
// Two sources, one shape. Our OWN share reports locally through
// `event:owned-folder-index-progress`, with `owned-folder:index-status` as the on-mount backstop so
// the notice is right before any event arrives. A PEER's share arrives as
// `event:share-index-progress`, re-announced by its owner over the handshake channel — ephemeral by
// design (a queue is not durable state), so there is nothing to read on mount and it stays blank
// until the first frame.
//
// Named subscriptions, not reconcile scopes: both are `decoration` events
// (test/unit/event-taxonomy.test.js), so they carry no scope and must never get a POKE_SCOPE row.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import type { IndexStatus } from '../indexSummary.js'

interface IndexProgressEvent extends IndexStatus {
  spaceId: string
  shareId: string
  ownerKey?: string
}

export interface IndexProgressSource {
  /** Our own share: report locally and read the backstop. */
  own: boolean
  /** The share's owner. A peer frame is accepted only from them. */
  ownerKey: string
  /**
   * Whether the source can still speak for itself — always true for our own share, and for a peer's
   * only while they are reachable. NOT merely a paint gate: a peer that drops mid-scan sends no
   * closing frame, so a latched count would survive the outage and reappear the moment presence
   * returned, describing work that finished long ago. A TTL would be the wrong instrument here —
   * frames are emitted when the queue changes shape, and a single multi-GB hash is minutes of
   * legitimate silence.
   */
  live: boolean
}

export function useIndexProgress(spaceId: string, shareId: string, source: IndexProgressSource): IndexStatus | null {
  const { own, ownerKey, live } = source
  const [status, setStatus] = useState<IndexStatus | null>(null)
  // Cleared DURING RENDER, not in the effect: FolderView is reused rather than keyed per share, so
  // an effect-time reset runs after the render that already carries the new share — one frame of
  // the previous folder's count under this folder's header. The same reason useShareFiles resets
  // its fold here. Every input is in the key, so a change of share, of side, of owner, or of
  // liveness drops what the old one said instead of latching it.
  const key = [spaceId, shareId, own, ownerKey, live].join('|')
  const [watched, setWatched] = useState(key)
  if (watched !== key) {
    setWatched(key)
    setStatus(null)
  }

  useEffect(() => {
    if (!spaceId || !shareId || !live) return
    let alive = true
    if (own) {
      request('owned-folder:index-status', { spaceId, shareId })
        // Narrowed to the two fields the notice reads, so both sources hold the same shape and a
        // later reader cannot come to depend on a field only one of them carries.
        .then((s) => { if (alive) setStatus({ adding: (s as IndexStatus)?.adding, bytesQueued: (s as IndexStatus)?.bytesQueued }) })
        .catch(() => {})
    }
    const event = own ? 'event:owned-folder-index-progress' : 'event:share-index-progress'
    const unsub = subscribe<IndexProgressEvent>(event, (msg) => {
      if (msg.spaceId !== spaceId || msg.shareId !== shareId) return
      // A peer frame describes someone else's share unless it came from that share's owner.
      if (!own && msg.ownerKey !== ownerKey) return
      setStatus({ adding: msg.adding, bytesQueued: msg.bytesQueued })
    })
    return () => { alive = false; unsub() }
  }, [spaceId, shareId, own, ownerKey, live])

  return status
}
