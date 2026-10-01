// Which snapshots a backup keeps. The three newest healthy ones always stay, whatever their age, and a
// snapshot that looks like a loss never counts toward any bucket — so a burst of them after a wipe
// can never push the last good snapshots out. Beyond that: the newest healthy snapshot per hour for
// two days, per day for a month, per week for half a year, per month after that. Suspect snapshots
// are kept a month as evidence.
const HOUR = 60 * 60 * 1000
const DAY = 24 * HOUR
const WEEK = 7 * DAY

export const RETENTION = Object.freeze({ hourlyFor: 48 * HOUR, dailyFor: 30 * DAY, weeklyFor: 26 * WEEK, minHealthy: 3, suspectFor: 30 * DAY })

function bucket(createdAt, now) {
  const age = now - createdAt
  if (age <= RETENTION.hourlyFor) return 'h' + Math.floor(createdAt / HOUR)
  if (age <= RETENTION.dailyFor) return 'd' + Math.floor(createdAt / DAY)
  if (age <= RETENTION.weeklyFor) return 'w' + Math.floor(createdAt / WEEK)
  return 'm' + new Date(createdAt).toISOString().slice(0, 7)
}

// snapshots: { name, createdAt (ms), suspect } in any order.
export function keepSet(snapshots, now) {
  const newestFirst = [...snapshots].sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1))
  const healthy = newestFirst.filter((s) => !s.suspect)
  const keep = new Set(healthy.slice(0, RETENTION.minHealthy).map((s) => s.name))
  const seen = new Set()
  for (const s of healthy) {
    const b = bucket(s.createdAt, now)
    if (!seen.has(b)) {
      seen.add(b)
      keep.add(s.name)
    }
  }
  for (const s of newestFirst) if (s.suspect && now - s.createdAt <= RETENTION.suspectFor) keep.add(s.name)
  return keep
}

export function referencedIds(manifest) {
  const ids = new Set()
  for (const core of manifest.cores) for (const segment of core.segments) for (const id of segment.parts) ids.add(id)
  for (const id of Object.values(manifest.files ?? {})) if (id) ids.add(id)
  return ids
}
