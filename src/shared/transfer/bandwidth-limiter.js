// Byte-denominated token bucket pacing content-plane transfers. Distinct from
// handshake-guard's createRateLimiter, which counts EVENTS per peer for abuse control:
// this one counts BYTES, is global, and delays rather than drops.
//
// The rate is read through a getter on every call, so a settings change applies to
// in-flight transfers with no re-plumbing.

// A cap below this would let a single chunk outlive ChunkScheduler's 30s idle watchdog,
// failing the transfer as if the network had stalled. Clamped here as well as in the UI.
export const MIN_BYTES_PER_SECOND = 32 * 1024

export function createBandwidthLimiter(getBytesPerSecond, { now = Date.now } = {}) {
  let tokens = 0
  let last = now()
  let timer = null
  const waiters = []

  // 0 / negative / non-finite all mean unlimited: a corrupt value must never throttle to
  // a crawl, so this fails OPEN (the inverse of the protective caps in runtime-config).
  function ratePerSecond() {
    const n = getBytesPerSecond()
    if (typeof n !== 'number' || !Number.isFinite(n) || n <= 0) return 0
    return Math.max(n, MIN_BYTES_PER_SECOND)
  }

  function refill(bps) {
    const t = now()
    const elapsed = t - last
    if (elapsed <= 0) return
    last = t
    tokens = Math.min(bps, tokens + (bps * elapsed) / 1000)
  }

  function consume(bytes) {
    const bps = ratePerSecond()
    if (bps === 0) return true
    refill(bps)
    if (tokens >= bytes) {
      tokens -= bytes
      return true
    }
    // A chunk larger than one second of budget never fits the bucket. Releasing it on a
    // full bucket and repaying the deficit keeps the long-run rate correct; refusing it
    // would stall the transfer permanently.
    if (bytes > bps && tokens >= bps) {
      tokens -= bytes
      return true
    }
    return false
  }

  function delayFor(bytes) {
    const bps = ratePerSecond()
    if (bps === 0) return 0
    const needed = Math.min(bytes, bps) - tokens
    if (needed <= 0) return 0
    return Math.ceil((needed / bps) * 1000)
  }

  function wake() {
    timer = null
    const pending = waiters.splice(0, waiters.length)
    for (const cb of pending) {
      try { cb() } catch {}
    }
  }

  // Deliberately NOT unref'd: a pending take() resolves only when this fires, so an
  // unref'd timer would let an otherwise-idle loop hang the serve loop forever. The timer
  // is sub-second and exists only while a transfer is actively throttled.
  function schedule(ms) {
    if (timer) return
    timer = setTimeout(wake, Math.max(1, ms))
  }

  return {
    // Non-blocking — for the synchronous download-assign loop.
    tryTake(bytes) {
      return consume(bytes)
    },

    // Awaited before serving a chunk. Resolves once the bytes are paid for.
    async take(bytes) {
      while (!consume(bytes)) {
        const ms = delayFor(bytes)
        await new Promise((resolve) => {
          waiters.push(resolve)
          schedule(ms)
        })
      }
    },

    // Returns bytes charged for work that never happened — a chunk assigned to a peer that
    // then disappeared, or a write that failed and will be re-assigned. Without this the
    // re-assignment charges the same bytes twice and the achieved rate drifts below the
    // configured cap for every transfer sharing this (process-wide) limiter.
    give(bytes) {
      const bps = ratePerSecond()
      if (bps === 0 || !(bytes > 0)) return
      // Capped at one second of budget, like refill: returning more would let a burst of
      // cancellations bank credit and overshoot the cap on the next assign.
      tokens = Math.min(bps, tokens + bytes)
    },

    // Retry hook for tryTake callers: fires once `bytes` should be affordable.
    whenAvailable(bytes, cb) {
      waiters.push(cb)
      schedule(delayFor(bytes))
    },

    isUnlimited() {
      return ratePerSecond() === 0
    },

    destroy() {
      if (timer) { clearTimeout(timer); timer = null }
      waiters.length = 0
    },
  }
}
