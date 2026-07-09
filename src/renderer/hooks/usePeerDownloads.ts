import { useState, useEffect, useRef } from 'react'
import { request, subscribe } from '../ipc.js'
import { SpeedSampler, decayedSpeed } from '../speedSampler.js'
import type { PeerDownloadSummary } from '../types.js'

interface SummaryEvent {
  channel?: string
  spaceId: string
  path: string
  peers: string[]
  pausedKeys?: string[]
  bytes: number
  total: number
}

// The worker re-announces every live serve row (active AND paused) on its 10s ledger sweep;
// this TTL only covers missed frames, so it spans ≥3 sweep periods. The explicit peers:[]
// clearing frame remains the fast removal path. Shared with usePeerDownloadDetail so both tiers
// expire "who is downloading" at the same time.
export const SERVE_TTL_MS = 35000

// Tier 1: the always-on summary of who is downloading each file WE serve in this
// space (peer set + aggregate bytes). Cheap — one event per file, throttled on the
// worker. Speed is derived here with the same SpeedSampler the download bar uses.
// Wired by both SpaceView (loose rows, keyed by '/'+relPath) and FolderView (owned
// folder rows, keyed by the bare relPath).
export function usePeerDownloads(spaceId: string) {
  const [byPath, setByPath] = useState(new Map<string, PeerDownloadSummary>())
  const samplersRef = useRef(new Map<string, SpeedSampler>())
  const lastSeenRef = useRef(new Map<string, number>())

  useEffect(() => {
    // A stale space's rows must never bleed into the next: clear the maps on every space change
    // (they are keyed by path only, so a same-named file in two spaces would otherwise collide).
    setByPath(new Map())
    samplersRef.current.clear()
    lastSeenRef.current.clear()
    let alive = true
    const drop = (path: string) => {
      samplersRef.current.delete(path)
      lastSeenRef.current.delete(path)
      setByPath((prev) => {
        if (!prev.has(path)) return prev
        const next = new Map(prev)
        next.delete(path)
        return next
      })
    }
    const apply = (msg: SummaryEvent) => {
      if (!alive || msg.spaceId !== spaceId) return
      const path = msg.path
      if (!msg.peers || msg.peers.length === 0) { drop(path); return }
      const sampler = samplersRef.current.get(path) ?? new SpeedSampler()
      samplersRef.current.set(path, sampler)
      const now = Date.now()
      sampler.push(now, msg.bytes)
      lastSeenRef.current.set(path, now)
      const avgSpeed = sampler.avg(now) ?? 0
      setByPath((prev) => {
        const next = new Map(prev)
        next.set(path, { spaceId: msg.spaceId, path, peerKeys: msg.peers, pausedKeys: msg.pausedKeys ?? [], bytes: msg.bytes, total: msg.total, avgSpeed })
        return next
      })
    }
    const unsub = subscribe<SummaryEvent>('event:awareness', (msg) => { if (msg.channel === 'serving') apply(msg) })
    // Seed from the worker's live snapshot: a view mounted while peers are already downloading
    // would otherwise show nothing until the next 10s sweep re-announce. Guard against the
    // response resolving (a microtask) AFTER a newer live frame for the same path already
    // applied — the snapshot is older, and the sweep re-announces only live rows, so it would
    // otherwise resurrect a just-cleared row for the full TTL. Skip a row we've already seen live.
    ;(request('serving:summary-list', { spaceId }) as Promise<SummaryEvent[]>)
      .then((rows) => {
        if (!alive) return
        for (const row of rows) {
          if (lastSeenRef.current.has(row.path)) continue
          apply(row)
        }
      })
      .catch(() => {})

    // Soft-state expiry (SWIM/awareness): the worker's ledger sweep re-announces every live row;
    // if no frame arrives within the TTL the indicator drops locally, so a missed "cleared"
    // summary can't leave a stale "who is downloading" row.
    const heartbeat = setInterval(() => {
      const now = Date.now()
      setByPath((prev) => {
        if (prev.size === 0) return prev
        let changed = false
        const next = new Map(prev)
        for (const [path, summary] of prev) {
          if ((lastSeenRef.current.get(path) ?? 0) + SERVE_TTL_MS < now) {
            samplersRef.current.delete(path); lastSeenRef.current.delete(path); next.delete(path); changed = true; continue
          }
          const avgSpeed = decayedSpeed(samplersRef.current.get(path), now, summary.avgSpeed)
          if (avgSpeed !== null && avgSpeed !== summary.avgSpeed) {
            next.set(path, { ...summary, avgSpeed })
            changed = true
          }
        }
        return changed ? next : prev
      })
    }, 1000)

    return () => { alive = false; unsub(); clearInterval(heartbeat); samplersRef.current.clear(); lastSeenRef.current.clear() }
  }, [spaceId])

  function getDownloadSummary(path: string): PeerDownloadSummary | null {
    // Defense in depth against a late cross-space row: the rows carry their spaceId, so never
    // return one that isn't this hook's current space even if it slipped into the path-keyed map.
    const summary = byPath.get(path)
    return summary && summary.spaceId === spaceId ? summary : null
  }

  return { getDownloadSummary }
}
