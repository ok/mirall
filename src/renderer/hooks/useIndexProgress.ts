// The owner's live folder-scan status: how many of its files are queued or being hashed right now.
//
// A named subscription, not a reconcile scope: event:owned-folder-index-progress is a `decoration`
// event (test/unit/event-taxonomy.test.js), so it carries no scope and must never get a POKE_SCOPE
// row. The frame carries the whole status, so it is latched directly rather than re-derived — the
// one-shot request below is the backstop that makes the notice correct on mount, before any event.
import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc.js'
import type { IndexStatus } from '../indexSummary.js'

interface IndexProgressEvent extends IndexStatus {
  spaceId: string
  shareId: string
}

export function useIndexProgress(spaceId: string, shareId: string): IndexStatus | null {
  const [status, setStatus] = useState<IndexStatus | null>(null)
  // Cleared DURING RENDER, not in the effect: FolderView is reused rather than keyed per share, so
  // an effect-time reset runs after the render that already carries the new share — one frame of
  // the previous folder's count under this folder's header. The same reason useShareFiles resets
  // its fold here. Empty ids take this path too, so leaving an owned folder drops its status
  // instead of latching it behind the caller's render guard.
  const [watched, setWatched] = useState(spaceId + '|' + shareId)
  const current = spaceId + '|' + shareId
  if (watched !== current) {
    setWatched(current)
    setStatus(null)
  }

  useEffect(() => {
    if (!spaceId || !shareId) return
    let alive = true
    request('owned-folder:index-status', { spaceId, shareId })
      .then((s) => { if (alive) setStatus(s as IndexStatus) })
      .catch(() => {})
    const unsub = subscribe<IndexProgressEvent>('event:owned-folder-index-progress', (msg) => {
      if (msg.spaceId !== spaceId || msg.shareId !== shareId) return
      setStatus({ adding: msg.adding, queued: msg.queued, running: msg.running, done: msg.done, failed: msg.failed, totalOnDisk: msg.totalOnDisk, bytesQueued: msg.bytesQueued })
    })
    return () => { alive = false; unsub() }
  }, [spaceId, shareId])

  return status
}
