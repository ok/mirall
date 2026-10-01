// When the next backup runs after a change. Changes that decide whether a restore is complete — a
// space created, joined or left, a space key — run within a minute; everyday changes (a file shared,
// a name edited) wait for three quiet minutes, at most an hour, and at least ten minutes apart.
export const URGENCY = Object.freeze({ URGENT: 'urgent', NORMAL: 'normal' })

const RULES = Object.freeze({
  urgent: { quietMs: 15_000, maxWaitMs: 60_000, minGapMs: 0 },
  normal: { quietMs: 180_000, maxWaitMs: 3_600_000, minGapMs: 600_000 },
})

export function nextRunAt({ firstDirtyAt, lastEventAt, urgency, lastRunAt, now }) {
  if (firstDirtyAt === null) return null
  const rule = RULES[urgency] ?? RULES.normal
  const due = Math.min(lastEventAt + rule.quietMs, firstDirtyAt + rule.maxWaitMs)
  return Math.max(due, (lastRunAt ?? -Infinity) + rule.minGapMs, now)
}
