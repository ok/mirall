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
}

export function useIndexProgress(spaceId: string, shareId: string, own: boolean): IndexStatus | null {
  const [status, setStatus] = useState<IndexStatus | null>(null)
  // Cleared DURING RENDER, not in the effect: FolderView is reused rather than keyed per share, so
  // an effect-time reset runs after the render that already carries the new share — one frame of
  // the previous folder's count under this folder's header. The same reason useShareFiles resets
  // its fold here. Empty ids and a change of side take this path too, so nothing latches.
  const [watched, setWatched] = useState(spaceId + '|' + shareId + '|' + own)
  const current = spaceId + '|' + shareId + '|' + own
  if (watched !== current) {
    setWatched(current)
    setStatus(null)
  }

  useEffect(() => {
    if (!spaceId || !shareId) return
    let alive = true
    if (own) {
      request('owned-folder:index-status', { spaceId, shareId })
        .then((s) => { if (alive) setStatus(s as IndexStatus) })
        .catch(() => {})
    }
    const event = own ? 'event:owned-folder-index-progress' : 'event:share-index-progress'
    const unsub = subscribe<IndexProgressEvent>(event, (msg) => {
      if (msg.spaceId !== spaceId || msg.shareId !== shareId) return
      setStatus({ adding: msg.adding, bytesQueued: msg.bytesQueued })
    })
    return () => { alive = false; unsub() }
  }, [spaceId, shareId, own])

  return status
}
