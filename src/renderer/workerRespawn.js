// Decides whether to respawn the Bare worker after it exits, and how long to wait.
//
// A worker that OOMs (a very large folder) or otherwise dies must NOT leave the app
// permanently dead — without a respawn, every later request just writes into the
// void and rejects after the 30s IPC timeout. So recovery is automatic. But a
// worker that re-crashes on boot must not respawn forever: consecutive crashes
// are capped and backed off exponentially.
//
// The streak resets only after the worker actually reached "ready" since the last exit
// (recordReady) — NOT merely because some wall-clock interval passed. So a worker that
// boots, works, then dies starts with a fresh budget, while one that crashes BEFORE ever
// becoming ready (a boot loop — the dangerous case) accumulates the streak until the cap
// and we give up.
export function makeRespawnPolicy({ maxRetries = 5, baseDelayMs = 500, maxDelayMs = 5000 } = {}) {
  let streak = 0
  let readySinceExit = false
  return {
    // Call on each worker exit. Returns { respawn, delayMs }.
    onExit() {
      if (readySinceExit) streak = 0 // it booted + became ready, then died → fresh budget
      readySinceExit = false
      if (streak >= maxRetries) return { respawn: false, delayMs: 0 }
      const delayMs = Math.min(baseDelayMs * 2 ** streak, maxDelayMs)
      streak += 1
      return { respawn: true, delayMs }
    },
    // Call when a (re)spawned worker reaches ready — proves this generation booted.
    recordReady() {
      readySinceExit = true
    },
  }
}
