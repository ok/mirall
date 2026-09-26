// When a local bee is worth rewriting, and the shape of the rewrite's state file. Pure, so the
// thresholds and the file's shape guard are unit-tested without a store.

// A rewrite must free at least this much, and history must dwarf the bee's fresh size by this ratio.
export const REWRITE_MIN_HISTORY_BYTES = 20 * 1000 * 1000
export const REWRITE_HISTORY_RATIO = 4

// The boot copies, verifies and refills a due bee's live data before the app opens; past this much
// the boot would stall, so the bee is left alone.
export const REWRITE_MAX_LIVE_BYTES = 64 * 1000 * 1000

// `overhead` is what the last copy of this bee measured as stored bytes per live byte (Hyperbee's
// index and the block encryption add to the entries themselves), 1 until a copy has run. A fresh copy
// lands at `liveBytes * overhead`, so the ratio cannot re-fire on a bee just rewritten.
export function rewriteDue({ coreBytes, liveBytes, overhead = 1 }) {
  if (liveBytes > REWRITE_MAX_LIVE_BYTES) return false
  const freshBytes = liveBytes * overhead
  return coreBytes - freshBytes >= REWRITE_MIN_HISTORY_BYTES && coreBytes >= REWRITE_HISTORY_RATIO * freshBytes
}

// Past this much live data no verdict can be "due", so the scan can stop.
export function liveScanLimit(coreBytes) {
  return Math.min(Math.floor(coreBytes / REWRITE_HISTORY_RATIO), REWRITE_MAX_LIVE_BYTES)
}

// A bee is scanned only when it is big enough to matter and its size moved by the floor since its
// last verdict: the audit log can hold hundreds of thousands of live rows, and scanning them on
// every start would cost seconds each time. A shrink (the audit purge truncates) re-scans too.
export function needsMeasure({ coreBytes, prior }) {
  if (coreBytes < REWRITE_MIN_HISTORY_BYTES) return false
  if (!prior) return true
  return coreBytes < prior.coreBytes || coreBytes - prior.coreBytes >= REWRITE_MIN_HISTORY_BYTES
}

// A copy that would not free at least half the floor is abandoned: the bytes do not justify the
// truncate.
export function rewriteSaves({ fromBytes, toBytes }) {
  return fromBytes - toBytes >= REWRITE_MIN_HISTORY_BYTES / 2
}

export function copyOverhead({ copyBytes, liveBytes }) {
  return Math.max(1, copyBytes / Math.max(1, liveBytes))
}

// The state file: the last verdict per bee, and the bee whose only complete copy is its scratch,
// with the bee's fork before the truncate and the scratch's length. Anything else is dropped, and a
// file that is not an object reads as empty.
export function normalizeRewriteState(raw) {
  const state = { v: 1, restoring: null, measured: {} }
  if (!isRecord(raw)) return state
  const r = raw.restoring
  if (isRecord(r) && typeof r.name === 'string' && isCount(r.fork) && isCount(r.scratchLength)) {
    state.restoring = { name: r.name, fork: r.fork, scratchLength: r.scratchLength }
  }
  if (!isRecord(raw.measured)) return state
  for (const [name, m] of Object.entries(raw.measured)) {
    if (!isRecord(m) || !isCount(m.coreBytes) || !isCount(m.liveBytes)) continue
    state.measured[name] = {
      coreBytes: m.coreBytes,
      liveBytes: m.liveBytes,
      overhead: Number.isFinite(m.overhead) && m.overhead >= 1 ? m.overhead : 1,
      at: isCount(m.at) ? m.at : 0,
    }
  }
  return state
}

const isRecord = (v) => !!v && typeof v === 'object' && !Array.isArray(v)
const isCount = (v) => Number.isSafeInteger(v) && v >= 0
