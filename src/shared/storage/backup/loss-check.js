// What a snapshot says about the store it captured — its vitals — and whether that looks like data was
// lost. A wipe of the whole profile cannot write into the old backup at all (another identity cannot
// open it); this catches the quieter losses, cores purged or spaces dropped, by comparing against the
// last snapshot that was not itself flagged, so a run of losses never becomes the new normal by
// accident. A drop that lasts a week is accepted as the new normal: a space left on purpose stops
// reading as a loss.
const OWN_ROLES = new Set(['profile', 'local-bee', 'intents', 'own-catalog', 'own'])

export const ACCEPT_AFTER_MS = 7 * 24 * 60 * 60 * 1000

export function storeVitals(entries, spaceCount) {
  let profileLength = 0
  let totalOwnLength = 0
  let ownCatalogs = 0
  for (const entry of entries) {
    if (entry.role === 'profile') profileLength = entry.length
    if (entry.role === 'own-catalog') ownCatalogs++
    if (OWN_ROLES.has(entry.role)) totalOwnLength += entry.length
  }
  return { spaces: spaceCount, ownCatalogs, cores: entries.length, profileLength, totalOwnLength }
}

// What to compare a new snapshot with: the last unflagged one, or — once flagged snapshots have
// followed it for a week — the newest snapshot, whose drop has become the normal.
export function lossBaseline(lastUnflagged, newest, now) {
  if (!lastUnflagged) return newest?.vitals ?? null
  if (newest?.suspect && now - Date.parse(lastUnflagged.createdAt) > ACCEPT_AFTER_MS) return newest.vitals
  return lastUnflagged.vitals
}

export function lossVerdict(baseline, now) {
  if (!baseline) return null
  const reasons = []
  if (now.profileLength < baseline.profileLength) reasons.push('profile-shrank')
  if (baseline.spaces >= 2 && now.spaces <= Math.floor(baseline.spaces / 2)) reasons.push('spaces-halved')
  if (baseline.cores >= 10 && now.cores < baseline.cores / 2) reasons.push('cores-halved')
  if (baseline.totalOwnLength > 0 && now.totalOwnLength < baseline.totalOwnLength * 0.7) reasons.push('own-data-shrank')
  return reasons.length ? { reasons } : null
}
