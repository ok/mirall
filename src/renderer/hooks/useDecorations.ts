import { useState, useEffect, useRef } from 'react'
import { subscribe } from '../ipc.js'
import { SpeedSampler, decayedSpeed } from '../speedSampler.js'

export type DecorationPhase = 'verifying' | 'preparing' | 'publishing'

export interface Decoration {
  bytes: number
  total: number
  speed: number
  avgSpeed: number
  eta: number | null
  phase?: DecorationPhase
  verifyFraction?: number
}

interface DecorationEvent {
  channel: string
  spaceId: string
  key: string
  bytes: number
  total: number
  speed?: number
  eta?: number | null
  phase?: DecorationPhase
  verifyFraction?: number
  done?: boolean
}

// Decoration ONLY: high-frequency progress painted onto a row whose status is already derived by
// the reconciled view. Holds no status. A missed event stutters the bar; the status is unaffected.
// Cleared ONLY by the terminal `done` signal — never by silence: the progress ticker is byte-driven
// (no chunk = no event), so a stalled-but-still-active download must keep its bar (parity with the
// folder path). A missed `done` leaves a harmless lingering entry that the row's derived status
// (no longer 'downloading') simply stops rendering.
// keyPrefix scopes the map to one consumer's key-space (loose keys are drive paths '/…', folder
// keys are 'shareId:relPath') so another surface's frames don't churn this one's renders.
export function useDecorations(channel: string, spaceId: string, keyPrefix?: string) {
  const [byKey, setByKey] = useState(new Map<string, Decoration>())
  const samplers = useRef(new Map<string, SpeedSampler>())

  useEffect(() => {
    setByKey(new Map())
    const drop = (key: string) => {
      samplers.current.delete(key)
      setByKey(prev => { if (!prev.has(key)) return prev; const n = new Map(prev); n.delete(key); return n })
    }
    const unsub = subscribe<DecorationEvent>('event:decoration', (m) => {
      if (m.channel !== channel || m.spaceId !== spaceId) return
      if (keyPrefix && !m.key.startsWith(keyPrefix)) return
      if (m.done) { drop(m.key); return }
      const now = Date.now()
      if (m.phase === 'verifying') {
        // Verify frames carry no fresh transfer bytes (the mirror path sends 0) — sampling them
        // would make the first post-verify frame span [0 → resumed offset] and report an absurd
        // speed. Reset the sampler so post-verify sampling starts clean.
        samplers.current.delete(m.key)
        setByKey(prev => {
          const n = new Map(prev)
          n.set(m.key, { bytes: m.bytes, total: m.total, speed: 0, avgSpeed: 0, eta: null, phase: m.phase, verifyFraction: m.verifyFraction })
          return n
        })
        return
      }
      const sampler = samplers.current.get(m.key) ?? new SpeedSampler()
      samplers.current.set(m.key, sampler)
      sampler.push(now, m.bytes)
      const avgSpeed = sampler.avg(now) ?? m.speed ?? 0
      setByKey(prev => {
        const n = new Map(prev)
        n.set(m.key, { bytes: m.bytes, total: m.total, speed: m.speed ?? 0, avgSpeed, eta: m.eta ?? null, phase: m.phase, verifyFraction: m.verifyFraction })
        return n
      })
    })
    // Decay avgSpeed toward zero on a stall so a frozen bar doesn't report a stale rate; the entry
    // itself persists until `done`.
    const hb = setInterval(() => {
      const now = Date.now()
      setByKey(prev => {
        if (prev.size === 0) return prev
        let changed = false
        const n = new Map(prev)
        for (const [key, d] of prev) {
          const avgSpeed = decayedSpeed(samplers.current.get(key), now, d.avgSpeed)
          if (avgSpeed !== null && avgSpeed !== d.avgSpeed) { n.set(key, { ...d, avgSpeed }); changed = true }
        }
        return changed ? n : prev
      })
    }, 1000)
    return () => { unsub(); clearInterval(hb); samplers.current.clear() }
  }, [channel, spaceId, keyPrefix])

  return {
    byKey,
    getDecoration: (key: string): Decoration | null => byKey.get(key) ?? null,
  }
}
