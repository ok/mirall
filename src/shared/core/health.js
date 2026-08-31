// Process-level health the diagnostics export did not have: five swarm counters were the whole
// picture. Loop lag is the signal that says the worker is wedged rather than merely busy, which is
// the one probe a per-subsystem supervisor needs and the one number no per-request metric can give.
//
// The clock and timer are injectable for the same reason the request vocabulary is: a test drives
// them directly instead of sleeping, which is what keeps this out of check-test-timing.sh.
const LAG_INTERVAL_MS = 1000

export function createHealthMonitor({
  now = Date.now,
  setInterval: setIv = setInterval,
  clearInterval: clearIv = clearInterval,
  intervalMs = LAG_INTERVAL_MS,
} = {}) {
  let lastLagMs = 0
  let maxLagMs = 0
  let timer = null
  let expected = 0

  function tick() {
    const drift = now() - expected
    expected = now() + intervalMs
    // A clock stepping backwards is not a healthy loop; clamping keeps a wedged worker from
    // reading as fast and keeps the max from being reset by a time correction.
    lastLagMs = drift > 0 ? drift : 0
    if (lastLagMs > maxLagMs) maxLagMs = lastLagMs
  }

  return {
    start() {
      if (timer) return
      expected = now() + intervalMs
      timer = setIv(tick, intervalMs)
      timer?.unref?.()
    },
    stop() {
      if (!timer) return
      clearIv(timer)
      timer = null
    },
    tick,
    snapshot(extra = {}) {
      return { loopLagMs: lastLagMs, loopLagMaxMs: maxLagMs, ...extra }
    },
    reset() { lastLagMs = 0; maxLagMs = 0 },
  }
}
