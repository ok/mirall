// Progress, not elapsed time. Supervised work in the worker is a keyed pass with at most one in
// flight, so a pass that never settles holds its key permanently. But a legitimate pass over
// thousands of files, or a roster fold over hundreds of peers, is genuinely slow — an elapsed-time
// rule would recover healthy work mid-pass. Only a pass that is in flight AND not advancing is
// stalled, which is why every caller has to supply a heartbeat.
export function stallVerdict(liveness, { now, windowMs }) {
  const { startedAt = 0, progressAt = 0 } = liveness || {}
  if (!startedAt) return { ok: true, detail: null }
  // A pass that has not reported progress yet falls back to its start, rather than reading as
  // stalled from the epoch.
  const stalledForMs = now - (progressAt || startedAt)
  if (stalledForMs <= windowMs) return { ok: true, detail: null }
  return { ok: false, detail: `no progress for ${Math.round(stalledForMs / 1000)}s` }
}
