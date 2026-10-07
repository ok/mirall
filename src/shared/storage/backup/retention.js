// Which snapshots a backup keeps: few, each with a reason to pick it. The newest snapshot always stays,
// so the next run has its base. Of the healthy ones: the newest, and the newest at least one and two
// days, one and two weeks, and one and two months old; an older one goes once a newer one fills its
// place. For RETENTION.pinFor after a loss appeared, its first flagged snapshot and the last healthy
// one before it stay, and after a space was left, the snapshot from before.
const DAY = 24 * 60 * 60 * 1000

export const RETENTION = Object.freeze({
  ages: Object.freeze([0, DAY, 2 * DAY, 7 * DAY, 14 * DAY, 30 * DAY, 60 * DAY]),
  pinFor: 30 * DAY,
})

// snapshots: { name, createdAt (ms), suspect } in any order; departures: the newest manifest's.
export function keepSet(snapshots, now, departures = []) {
  const newestFirst = [...snapshots].sort((a, b) => b.createdAt - a.createdAt || (a.name < b.name ? 1 : -1))
  const keep = new Set(newestFirst.slice(0, 1).map((s) => s.name))
  const healthy = newestFirst.filter((s) => !s.suspect)
  for (const age of RETENTION.ages) {
    const kept = healthy.find((s) => now - s.createdAt >= age)
    if (kept) keep.add(kept.name)
  }
  newestFirst.forEach((s, i) => {
    const older = newestFirst.slice(i + 1)
    if (!s.suspect || older[0]?.suspect || now - s.createdAt > RETENTION.pinFor) return
    keep.add(s.name)
    const before = older.find((o) => !o.suspect)
    if (before) keep.add(before.name)
  })
  for (const departure of departures) {
    if (now - Date.parse(departure.at) <= RETENTION.pinFor) keep.add(departure.before)
  }
  return keep
}

export function referencedIds(manifest) {
  const ids = new Set()
  for (const core of manifest.cores) for (const segment of core.segments) for (const id of segment.parts) ids.add(id)
  for (const id of Object.values(manifest.files ?? {})) if (id) ids.add(id)
  return ids
}
