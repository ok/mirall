// A per-kind token bucket. On overflow it reports ONE suppressed count per window rather than
// dropping silently: a gap the reader cannot see is worse than a visible one.
export function createRateGuard({ windowMs, max, now = Date.now, onSuppressed }) {
  const buckets = new Map()

  function admit(kind) {
    const at = now()
    let bucket = buckets.get(kind)
    if (!bucket || at - bucket.windowStart >= windowMs) {
      const suppressed = bucket?.suppressed ?? 0
      bucket = { count: 0, windowStart: at, suppressed: 0 }
      buckets.set(kind, bucket)
      if (suppressed > 0) onSuppressed(kind, suppressed)
    }
    if (bucket.count >= max) {
      bucket.suppressed += 1
      return false
    }
    bucket.count += 1
    return true
  }

  return { admit, reset: () => buckets.clear() }
}
