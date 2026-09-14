import { useRef } from 'react'
import { SpeedSampler, decayedSpeed } from '../speedSampler.js'

// The speed sampler and the last-seen clock for a set of live rows. They are one thing: a sampler
// outlives its row unless it is dropped with it, and a last-seen with no sampler reports no speed.
// Holding them as two maps means every removal has to remember both — this keeps the pair together
// so it cannot be half-forgotten.
//
// Keys are whatever the caller's rows are keyed by: a file path for the per-file tier, a peer key
// for the per-peer one.
export interface SpeedTracker {
  // Record a row's byte count and return its current average speed.
  observe: (key: string, now: number, bytes: number) => number
  // Whether a row has been seen at all — the seed uses it to skip a row a live frame already set.
  seen: (key: string) => boolean
  // Whether a row's last sighting is older than its time-to-live.
  expired: (key: string, now: number, ttlMs: number) => boolean
  // The speed a silent row decays to, or null when it has not moved.
  decay: (key: string, now: number, current: number) => number | null
  forget: (key: string) => void
  // Drop every row that is not in this set — the authoritative snapshot's key list.
  retain: (keys: Set<string>) => void
  reset: () => void
}

export function useSpeedTracker(): SpeedTracker {
  const samplers = useRef(new Map<string, SpeedSampler>())
  const lastSeen = useRef(new Map<string, number>())
  const tracker = useRef<SpeedTracker | null>(null)

  if (!tracker.current) {
    const forget = (key: string) => {
      samplers.current.delete(key)
      lastSeen.current.delete(key)
    }
    tracker.current = {
      observe(key, now, bytes) {
        const sampler = samplers.current.get(key) ?? new SpeedSampler()
        samplers.current.set(key, sampler)
        sampler.push(now, bytes)
        lastSeen.current.set(key, now)
        return sampler.avg(now) ?? 0
      },
      seen: (key) => lastSeen.current.has(key),
      expired: (key, now, ttlMs) => (lastSeen.current.get(key) ?? 0) + ttlMs < now,
      decay: (key, now, current) => decayedSpeed(samplers.current.get(key), now, current),
      forget,
      retain(keys) {
        for (const key of [...samplers.current.keys()]) if (!keys.has(key)) forget(key)
      },
      reset() {
        samplers.current.clear()
        lastSeen.current.clear()
      },
    }
  }
  return tracker.current
}
