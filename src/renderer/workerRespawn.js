// Respawn after a crash — without it every later request rejects after the IPC timeout — capped at
// 5 with exponential backoff. The streak resets only after a generation reached ready
// (recordReady): a boot loop accumulates to the cap, boot-work-die earns a fresh budget.
// WORKER_EXIT_UNSTABLE keeps a SEPARATE budget of 3 per 10 min that recordReady never clears (an
// unstable worker HAS reached ready, every time); only quiet time clears it.
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
