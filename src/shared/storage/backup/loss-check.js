// What a snapshot says about the store it captured — its vitals — and whether that looks like data was
// lost. A wipe of the whole profile cannot write into the old backup at all (another identity cannot
// open it); this catches the quieter losses, cores purged or spaces dropped, by comparing against the
// last snapshot that was not itself flagged, so a run of losses never becomes the new normal by
// accident. A drop that lasts a week is accepted as the new normal. A space the person removed on
// purpose (removal-evidence.js) is taken out of the baseline first, so only a drop nothing explains is
// compared. Local bees never count as own data: an Activity Log purge and a rewrite in place shorten
// them on purpose.
const OWN_ROLES = new Set(['profile', 'intents', 'own-catalog', 'own'])

export const ACCEPT_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export function storeVitals(entries, spaceCount) {
  let profileLength = 0
  let ownLength = 0
  let ownCatalogs = 0
  for (const entry of entries) {
    if (entry.role === 'profile') profileLength = entry.length
    if (entry.role === 'own-catalog') ownCatalogs++
    if (OWN_ROLES.has(entry.role)) ownLength += entry.length
  }
  return { spaces: spaceCount, ownCatalogs, cores: entries.length, profileLength, ownLength }
}

// What to compare a new snapshot with: the last unflagged one, or — once flagged snapshots have
// followed it for a week — the newest snapshot, whose drop has become the normal.
export function lossBaselineManifest(lastUnflagged, newest, now) {
  if (!lastUnflagged) return newest ?? null
  if (newest?.suspect && now - Date.parse(lastUnflagged.createdAt) > ACCEPT_AFTER_MS) return newest
  return lastUnflagged
}

// What removals through the leave and join flows account for since the baseline: the removed spaces,
// the cores the baseline attributes to them that are gone, and how much shorter their own cores are.
// A removal never explains the profile, the intents, or another space's data. Of a space joined
// again, it explains what the baseline held from before the removal, and after that only own cores
// nothing names any more — the leftovers of the first membership, never the live ones.
// removals: spaceId → time of its latest removal; now: { cores, spaces } of the new snapshot.
export function explainedLoss(baseline, now, removals) {
  const takenAt = Date.parse(baseline.createdAt)
  const current = new Set(now.spaces.map((space) => space.id))
  const explains = (core) => {
    const removedAt = core.spaceId ? removals.get(core.spaceId) : undefined
    if (removedAt === undefined) return false
    return !current.has(core.spaceId) || removedAt >= takenAt || core.role === 'own'
  }
  const nowByDk = new Map(now.cores.map((core) => [core.dk, core]))
  let cores = 0
  let ownLength = 0
  for (const core of baseline.cores ?? []) {
    if (!explains(core)) continue
    const after = nowByDk.get(core.dk)
    if (!after) cores++
    if (OWN_ROLES.has(core.role)) ownLength += Math.max(0, core.length - (after?.length ?? 0))
  }
  const spaces = (baseline.spaces ?? []).filter((space) => removals.has(space.id) && !current.has(space.id)).length
  return { spaces, cores, ownLength }
}

export function adjustBaseline(baseline, explained) {
  return {
    ...baseline,
    spaces: baseline.spaces - explained.spaces,
    cores: baseline.cores - explained.cores,
    ownLength: baseline.ownLength - explained.ownLength,
  }
}

export function lossVerdict(baseline, now) {
  if (!baseline) return null
  const reasons = []
  if (now.profileLength < baseline.profileLength) reasons.push('profile-shrank')
  if (baseline.spaces >= 2 && now.spaces <= Math.floor(baseline.spaces / 2)) reasons.push('spaces-halved')
  if (baseline.cores >= 10 && now.cores < baseline.cores / 2) reasons.push('cores-halved')
  if (baseline.ownLength > 0 && now.ownLength < baseline.ownLength * 0.7) reasons.push('own-data-shrank')
  return reasons.length ? { reasons } : null
}
