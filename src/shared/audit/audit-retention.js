// Retention boundary math. Pure, so the awkward cases — clock jump, count cap, empty log —
// test without any I/O.
//
// Pruning is by age AND count, whichever binds first: a pathological burst must not blow disk
// even inside the retention window.

// `seq` is strictly monotonic but `ts` is only usually so — a backwards clock jump (NTP, sleep,
// timezone) breaks the correspondence. So an age boundary is never binary-searched; it is a
// scan filter, and a walk may only stop after this many CONSECUTIVE rows below the cutoff.
export const AGE_HYSTERESIS = 20

export const DEFAULT_RETENTION_DAYS = 90
export const DEFAULT_MAX_ENTRIES = 200000

const DAY_MS = 86400000

export function ageCutoff(now, retentionDays) {
  if (!Number.isFinite(retentionDays) || retentionDays <= 0) return null
  return now - retentionDays * DAY_MS
}

// test seam
export function countCutoffSeq(newestSeq, maxEntries) {
  if (!Number.isFinite(maxEntries) || maxEntries <= 0) return null
  if (!Number.isInteger(newestSeq) || newestSeq < 0) return null
  return newestSeq - maxEntries
}

// The highest seq that should be deleted (inclusive), or null when nothing qualifies.
// `seqAtOrBelowAge` is the caller's scan result: the highest seq whose ts is older than the age
// cutoff, or null if the scan found none.
export function pruneUpTo({ retentionDays, maxEntries, newestSeq, seqAtOrBelowAge = null }) {
  const byCount = countCutoffSeq(newestSeq, maxEntries)
  const candidates = [seqAtOrBelowAge, byCount].filter((v) => Number.isInteger(v) && v >= 0)
  return candidates.length ? Math.max(...candidates) : null
}

export function normalizeConfig(patch, current) {
  const next = { ...current }
  if (typeof patch.enabled === 'boolean') next.enabled = patch.enabled
  if (Number.isFinite(patch.retentionDays) && patch.retentionDays > 0) {
    next.retentionDays = Math.floor(patch.retentionDays)
  }
  if (Number.isFinite(patch.maxEntries) && patch.maxEntries > 0) {
    next.maxEntries = Math.floor(patch.maxEntries)
  }
  return next
}

// The highest seq whose ts is older than `cutoff`, or null when no row is. `records` is walked
// oldest-first and the walk stops after AGE_HYSTERESIS consecutive younger rows. Deletion is
// inclusive of the result, and a clock step-back can put a stale ts AFTER fresh rows, so the
// result is capped below the first young row rather than dragged past it.
export async function ageWatermark(records, cutoff) {
  let watermark = null
  let firstYoungSeq = null
  let young = 0
  for await (const rec of records) {
    if (rec.ts < cutoff) {
      watermark = rec.seq
      young = 0
      continue
    }
    if (firstYoungSeq === null) firstYoungSeq = rec.seq
    young += 1
    if (young >= AGE_HYSTERESIS) break
  }
  if (firstYoungSeq !== null && watermark !== null && watermark >= firstYoungSeq) watermark = firstYoungSeq - 1
  return watermark !== null && watermark >= 0 ? watermark : null
}
