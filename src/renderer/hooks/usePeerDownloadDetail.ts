import { useState, useEffect, useRef } from 'react'
import { request, subscribe } from '../ipc.js'
import { SpeedSampler, decayedSpeed } from '../speedSampler.js'
import { SERVE_TTL_MS } from './usePeerDownloads.js'
import type { PeerDownloadPeer } from '../types.js'

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
        // Soft-state expiry: a peer whose authoritative snapshot went silent past the TTL is dropped
        // (a paused peer is kept — the worker holds paused rows far longer). Backstops a missed frame.
        const live = prev.filter((p) => p.paused || (lastSeen.get(p.peerKey) ?? 0) + SERVE_TTL_MS >= now)
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
