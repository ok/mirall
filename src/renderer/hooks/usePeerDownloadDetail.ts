import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc/ipc.js'
import { useSpeedTracker } from './useSpeedTracker.js'
import { SERVE_TTL_MS } from './usePeerDownloads.js'
import type { PeerDownloadPeer } from '../types/types.js'
import type { ServeDetailPeer } from '../../shared/contract/responses.js'

// A paused peer is kept far longer than an active one — the worker holds paused rows for
// PAUSED_DROP_MS (300s) and re-announces every ~10s — but not forever: if those re-announces
// stop (a worker ledger reset emits no clear, a dropped frame, an overlay restart) the row must
// still age out. Above the worker's PAUSED_DROP_MS so the authoritative clear wins in the normal path.
const PAUSED_SERVE_TTL_MS = 330000

interface DetailEvent {
  channel?: string
  spaceId: string
  path: string
  peers: ServeDetailPeer[]
}

// Tier 2: per-peer progress for ONE file, gated by mount — the worker streams detail for a
// (spaceId, path) only while this hook is subscribed (detail-subscribe on mount renders the returned
// snapshot; detail-unsubscribe on unmount). The ledger sweep pushes the authoritative snapshot, empty
// included, so a missed "peer gone" frame self-corrects. Outside the query store: a subscription with
// a teardown is not a query, and the store has no way to tell the worker to stop producing answers.
export function usePeerDownloadDetail(spaceId: string, path: string): PeerDownloadPeer[] {
  const [peers, setPeers] = useState<PeerDownloadPeer[]>([])
  const speed = useSpeedTracker()

  useEffect(() => {
    let active = true

    const apply = (list: ServeDetailPeer[]) => {
      const now = Date.now()
      speed.retain(new Set(list.map((p) => p.personKey)))
      setPeers(list.map((p) => ({
        personKey: p.personKey,
        bytes: p.bytes,
        total: p.total,
        avgSpeed: speed.observe(p.personKey, now, p.bytes),
        paused: !!p.paused,
      })))
    }

    request('serving:detail-subscribe', { spaceId, path }).then((snap) => {
      if (!active) return
      if (Array.isArray(snap?.peers)) apply(snap.peers)
    }).catch(() => {})

    const unsub = subscribe<DetailEvent>('event:awareness', (msg) => {
      if (msg.channel === 'serving-detail' && msg.spaceId === spaceId && msg.path === path) apply(msg.peers)
    })

    const heartbeat = setInterval(() => {
      const now = Date.now()
      setPeers((prev) => {
        if (prev.length === 0) return prev
        // Soft-state expiry: a peer whose authoritative snapshot went silent past the TTL is dropped.
        // A paused peer gets the longer PAUSED_SERVE_TTL_MS (the worker holds paused rows far longer)
        // but still ages out, so a missed clearing frame can't strand it forever.
        const live = prev.filter((p) => !speed.expired(p.personKey, now, p.paused ? PAUSED_SERVE_TTL_MS : SERVE_TTL_MS))
        speed.retain(new Set(live.map((p) => p.personKey)))
        let changed = live.length !== prev.length
        const next = live.map((p) => {
          const avgSpeed = speed.decay(p.personKey, now, p.avgSpeed)
          if (avgSpeed !== null && avgSpeed !== p.avgSpeed) { changed = true; return { ...p, avgSpeed } }
          return p
        })
        return changed ? next : prev
      })
    }, 1000)

    return () => {
      active = false
      unsub()
      clearInterval(heartbeat)
      speed.reset()
      request('serving:detail-unsubscribe', { spaceId, path }).catch(() => {})
    }
  }, [spaceId, path])

  return peers
}
