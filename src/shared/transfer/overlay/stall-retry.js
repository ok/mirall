// The stall auto-retry.
//
// or one whose UPLOAD cap kept it silent past our no-progress watchdog — and a holder that never
// disconnects fires NEITHER auto-resume trigger (owner reconnect, catalog append). Retry here
// while the owner is online, and keep retrying only while the retries bank bytes: a wedged holder
// banks none and parks after STALL_RETRY_DRY_LIMIT attempts. Keep-alives (message 14) keep a NEW
// holder off this path only as long as its keep-alive budget lasts, so this is the backstop for
// both cases.
//
// It lives apart from the engine because it owns a timer per transfer: a map of handles that must
// be cleared on pause, cancel, supersede and teardown, and a retry that must not outlive the
// engine that armed it. Everything else it needs is passed in.

const STALL_RETRY_BASE_MS = 3000
// Binds only if STALL_RETRY_DRY_LIMIT is raised: at 3 the backoff reaches 3s/6s/12s and stops.
const STALL_RETRY_MAX_MS = 60000
const STALL_RETRY_DRY_LIMIT = 3

import { nextRetryDelay } from './fetch-policy.js'

export function createStallRetry({ registry, pausedHashes, ownerOnline, channel, pokeResume, getPendingFor, pauseReasonFor, log, opts = {} }) {
  const stallRetries = new Map()

  function cancelStallRetry(transferId) {
    const st = stallRetries.get(transferId)
    if (!st) return
    clearTimeout(st.timer)
    stallRetries.delete(transferId)
  }

  // Schedule a retry of a stalled fetch. TRUE means one is pending, and the caller passes
  // `retrying` to emitPaused so the row still settles its decoration while the OS notification
  // is withheld — one notification per attempt would turn a slow transfer into a stream of them.
  async function scheduleStallRetry(job) {
    const { transferId } = job
    const retryBaseMs = opts.baseMs ?? STALL_RETRY_BASE_MS
    const retryMaxMs = opts.maxMs ?? STALL_RETRY_MAX_MS
    const retryDryLimit = opts.dryLimit ?? STALL_RETRY_DRY_LIMIT
    // Every bail DELETES the record. A leftover is keyed by a stable transferId
    // (spaceId|shareId|relPath), so an unrelated download of the same file hours later would
    // read it as `prev` and inherit an exhausted budget it never spent.
    if (!ownerOnline(job.ownerKey)) { cancelStallRetry(transferId); return false } // reconnect re-drives this
    if (pausedHashes.has(transferId)) { cancelStallRetry(transferId); return false }     // the user's pause outranks a retry
    const row = await getPendingFor(job.spaceId, job.pendingKey).catch(() => null)
    if (!row) { cancelStallRetry(transferId); return false }                             // row gone: nothing to resume
    const bytes = row.bytesTransferred || 0
    const prev = stallRetries.get(transferId)
    // Progress since the last attempt clears the counter — that is what lets a paced transfer
    // keep going, one attempt at a time, without a retry budget it can exhaust.
    const dry = prev && bytes <= prev.bytes ? prev.dry + 1 : 0
    const delayMs = nextRetryDelay({ dry, baseMs: retryBaseMs, maxMs: retryMaxMs, dryLimit: retryDryLimit })
    if (delayMs === null) { cancelStallRetry(transferId); return false }
    // Replacing a record must clear its timer, or the old one fires unreachable: cancelStallRetry
    // only ever sees the map's CURRENT record, so an orphan survives pause, discard and leave —
    // and re-creates the row they just purged.
    cancelStallRetry(transferId)
    const st = { dry, bytes, timer: null }
    st.timer = setTimeout(() => {
      st.timer = null
      retryNow(job, bytes, dry).catch((err) => log.debug('overlay stall-retry failed:', err.message))
    }, delayMs)
    st.timer.unref?.()
    stallRetries.set(transferId, st)
    return true
  }

  // The retry re-drives the SAME level-triggered recovery scan a reconnect uses rather than
  // replaying the job captured before the stall: everything that can change across a backoff is
  // re-derived there and nowhere else — the owner's catalog, the destination against the space's
  // CURRENT download folder, and a source tombstoned, re-added or re-hashed under us. A replayed
  // job would undo all of that, and its `recordPending` would re-create rows a leave just purged
  // (during a backoff there is no registry slot for a teardown path to find).
  async function retryNow(job, bytes, dry) {
    const { transferId } = job
    // A manual resume, a reconcile-driven start, or a pause may have landed in the window; all
    // of them outrank this. The record stays so the dry counter keeps measuring
    // attempts-without-progress no matter who started them.
    if (registry.has(transferId) || pausedHashes.has(transferId)) return
    if (!ownerOnline(job.ownerKey)) return settleRetryAsPaused(job)
    // Bookkeeping only — the scan itself iterates rows, so a purged one starts nothing either
    // way; this is what releases the record so it cannot be inherited by a later transfer of
    // the same path (the key is a stable spaceId|shareId|relPath).
    const row = await getPendingFor(job.spaceId, job.pendingKey).catch(() => null)
    if (!row) { cancelStallRetry(transferId); return }
    log.debug('overlay download stall-retry:', job.relPath, '— attempt', dry + 1, 'at', bytes, 'bytes')
    pokeResume(job.ownerKey, job.spaceId)
  }

  // Give up on a retry without a fetch to settle it: the row must still land in a terminal paused
  // state, or the transfer is left with no event at all — emitPaused is what terminates the
  // decoration, on either channel.
  function settleRetryAsPaused(job) {
    cancelStallRetry(job.transferId)
    channel.emitPaused?.(job, pauseReasonFor(job))
    channel.emitUpdated(job.spaceId)
  }

  // test seam: the retry records, so a test can assert the dry counter and that a pause cleared it
  return { schedule: scheduleStallRetry, cancel: cancelStallRetry, settleAsPaused: settleRetryAsPaused, records: stallRetries }
}
