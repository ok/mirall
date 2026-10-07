// When a run writes a snapshot, and which spaces it records as left. Bookkeeping — the Activity Log,
// download and transfer records, storage measurements, migration marks — changes on its own all day,
// so it never brings about a snapshot; its changes ride along in the next one something else does.
// Members' catalogs do bring one about.
import { RETENTION } from './retention.js'

const BOOKKEEPING_BEES = new Set(['audit-log', 'downloads-meta', 'pending-transfers', 'reclaim-meta', 'app-migrations'])

const isBookkeeping = (entry) => entry.role === 'local-bee' && BOOKKEEPING_BEES.has(entry.name)

// changed / gone: the manifest entries of the cores that changed since the previous snapshot, and of
// those no longer in the store.
export function snapshotDue({ first, filesChanged, changed, gone }) {
  return first || filesChanged || changed.some((entry) => !isBookkeeping(entry)) || gone.some((entry) => !isBookkeeping(entry))
}

// Every snapshot carries the departures of the last RETENTION.pinFor: the spaces left, and the
// snapshot from before. Retention keeps that snapshot and a restore names it, from the newest
// manifest alone. A previous snapshot that recorded no spaces has nothing to compare with.
export function nextDepartures(previous, spaces, now) {
  const recent = (previous?.manifest.departures ?? []).filter((departure) => now - Date.parse(departure.at) <= RETENTION.pinFor)
  if (!previous?.manifest.spaces) return recent
  const ids = new Set(spaces.map((space) => space.id))
  const left = previous.manifest.spaces.filter((space) => !ids.has(space.id))
  if (left.length === 0) return recent
  return [...recent, { before: previous.name, at: new Date(now).toISOString(), spaces: left.map((space) => space.name) }]
}
