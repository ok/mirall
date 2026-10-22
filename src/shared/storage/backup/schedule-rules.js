// When the next backup runs after a change. Changes that decide whether a restore is complete — a
// space created, joined or left, a space key — run within a minute; everyday changes (a file shared,
// a name edited) wait for three quiet minutes, at most an hour, and at least ten minutes apart. After a
// failed run the next waits a minute, doubling with each failure in a row up to fifteen: a folder that
// is gone fails at once, and without the wait its changes would be retried as fast as the check fails.
export const URGENCY = Object.freeze({ URGENT: 'urgent', NORMAL: 'normal' })

const RULES = Object.freeze({
  urgent: { quietMs: 15_000, maxWaitMs: 60_000, minGapMs: 0 },
  normal: { quietMs: 180_000, maxWaitMs: 3_600_000, minGapMs: 600_000 },
})

const RETRY_FIRST_MS = 60_000
const RETRY_MAX_MS = 900_000

export function nextRunAt({ firstDirtyAt, lastEventAt, urgency, lastRunAt, now, failures = 0 }) {
  if (firstDirtyAt === null) return null
  const rule = RULES[urgency] ?? RULES.normal
  const due = Math.min(lastEventAt + rule.quietMs, firstDirtyAt + rule.maxWaitMs)
  const retryMs = failures > 0 ? Math.min(RETRY_FIRST_MS * 2 ** (failures - 1), RETRY_MAX_MS) : 0
  return Math.max(due, (lastRunAt ?? -Infinity) + Math.max(rule.minGapMs, retryMs), now)
}
