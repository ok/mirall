import { useState, useEffect } from 'react'
import { request, subscribe } from '../ipc/ipc.js'
import { useSpeedTracker } from './useSpeedTracker.js'
import { SERVE_TTL_MS } from './usePeerDownloads.js'
import type { PeerDownloadPeer } from '../types/types.js'

// A paused peer is kept far longer than an active one — the worker holds paused rows for
// PAUSED_DROP_MS (300s) and re-announces every ~10s — but not forever: if those re-announces
// stop (a worker ledger reset emits no clear, a dropped frame, an overlay restart) the row must
// still age out. Above the worker's PAUSED_DROP_MS so the authoritative clear wins in the normal path.
const PAUSED_SERVE_TTL_MS = 330000

interface DetailPeer {
  peerKey: string
  bytes: number
  total: number
  paused?: boolean
}

interface DetailEvent {
  channel?: string
  spaceId: string
  path: string
  peers: DetailPeer[]
}

interface DetailSnapshot {
  peers: DetailPeer[]
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

    const apply = (list: DetailPeer[]) => {
      const now = Date.now()
      speed.retain(new Set(list.map((p) => p.peerKey)))
      setPeers(list.map((p) => ({
        peerKey: p.peerKey,
        bytes: p.bytes,
        total: p.total,
        avgSpeed: speed.observe(p.peerKey, now, p.bytes),
        paused: !!p.paused,
      })))
    }

    request('serving:detail-subscribe', { spaceId, path }).then((snap) => {
      if (!active) return
      const data = snap as DetailSnapshot
      if (data && Array.isArray(data.peers)) apply(data.peers)
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
        const live = prev.filter((p) => !speed.expired(p.peerKey, now, p.paused ? PAUSED_SERVE_TTL_MS : SERVE_TTL_MS))
        speed.retain(new Set(live.map((p) => p.peerKey)))
        let changed = live.length !== prev.length
        const next = live.map((p) => {
          const avgSpeed = speed.decay(p.peerKey, now, p.avgSpeed)
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
