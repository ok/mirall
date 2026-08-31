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
//
// That reset is exactly wrong for one exit, which is why WORKER_EXIT_UNSTABLE gets a budget of
// its own. A worker reporting its own fault rate as unstable HAS reached ready — every time —
// so the reset above hands it an unlimited budget and it respawns forever. Each of those
// respawns also reloads the window (ipc.ts markReady), so the user sees the app restart itself
// every time the worker gives up. The unstable budget is deliberately NOT cleared by recordReady;
// only quiet time clears it, because an unstable exit an hour apart is not a loop.
import { WORKER_EXIT_UNSTABLE } from '../shared/contract/exit-codes.js'

export function makeRespawnPolicy({
  maxRetries = 5, baseDelayMs = 500, maxDelayMs = 5000,
  maxUnstable = 3, unstableWindowMs = 10 * 60 * 1000, now = Date.now,
} = {}) {
  let streak = 0
  let readySinceExit = false
  let unstableStreak = 0
  let lastUnstableAt = 0
  return {
    // Call on each worker exit, with the exit code. Returns { respawn, delayMs }.
    onExit(code) {
      if (code === WORKER_EXIT_UNSTABLE) {
        const t = now()
        // A generation that ran clean for longer than the window means the previous unstable exit
        // was an incident, not a loop — start counting again rather than holding it against the
        // app for the rest of the session.
        if (lastUnstableAt && t - lastUnstableAt > unstableWindowMs) unstableStreak = 0
        lastUnstableAt = t
        if (unstableStreak >= maxUnstable) return { respawn: false, delayMs: 0 }
        unstableStreak += 1
      }
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
