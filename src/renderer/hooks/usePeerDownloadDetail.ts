import { useState, useEffect, useRef } from 'react'
import { request, subscribe } from '../ipc.js'
import { SpeedSampler, decayedSpeed } from '../speedSampler.js'
import { SERVE_TTL_MS } from './usePeerDownloads.js'
import type { PeerDownloadPeer } from '../types.js'

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

// Tier 2: per-peer progress for ONE file, gated by mount — the worker only streams detail
// for a (spaceId, path) while this hook is subscribed, so closing the dropdown (unmounting)
// stops the per-peer firehose. Mount calls detail-subscribe (rendering the returned snapshot
// immediately); progress frames update live; the worker's ledger sweep pushes the
// authoritative snapshot (empty included), so a missed "peer gone" frame self-corrects
// without any renderer poll or silence-TTL guessing. Unmount calls detail-unsubscribe.
// Deliberately outside the query store: this owns an explicit serving:detail-subscribe /
// serving:detail-unsubscribe RPC pair, and a subscription with a teardown is not a query. The store
// caches and refetches answers; it has no concept of telling the worker to stop producing them.
export function usePeerDownloadDetail(spaceId: string, path: string): PeerDownloadPeer[] {
  const [peers, setPeers] = useState<PeerDownloadPeer[]>([])
  const samplersRef = useRef(new Map<string, SpeedSampler>())
  const lastSeenRef = useRef(new Map<string, number>())

  useEffect(() => {
    let active = true
    const samplers = samplersRef.current
    const lastSeen = lastSeenRef.current

    const apply = (list: DetailPeer[]) => {
      const now = Date.now()
      const present = new Set(list.map((p) => p.peerKey))
      for (const key of [...samplers.keys()]) if (!present.has(key)) { samplers.delete(key); lastSeen.delete(key) }
      setPeers(list.map((p) => {
        const sampler = samplers.get(p.peerKey) ?? new SpeedSampler()
        samplers.set(p.peerKey, sampler)
        sampler.push(now, p.bytes)
        lastSeen.set(p.peerKey, now)
        return { peerKey: p.peerKey, bytes: p.bytes, total: p.total, avgSpeed: sampler.avg(now) ?? 0, paused: !!p.paused }
      }))
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
        const live = prev.filter((p) => (lastSeen.get(p.peerKey) ?? 0) + (p.paused ? PAUSED_SERVE_TTL_MS : SERVE_TTL_MS) >= now)
        for (const p of prev) if (!live.includes(p)) { samplers.delete(p.peerKey); lastSeen.delete(p.peerKey) }
        let changed = live.length !== prev.length
        const next = live.map((p) => {
          const avgSpeed = decayedSpeed(samplers.get(p.peerKey), now, p.avgSpeed)
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
      samplers.clear()
      lastSeen.clear()
      request('serving:detail-unsubscribe', { spaceId, path }).catch(() => {})
    }
  }, [spaceId, path])

  return peers
}
