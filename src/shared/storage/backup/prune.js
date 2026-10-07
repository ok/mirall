// Thinning a backup to what retention keeps. A snapshot that cannot be read is kept — it is never
// deleted unclassified — and while one exists no object is deleted, since it may name any of them.
// Otherwise an object goes only when no kept snapshot names it and it is older than an hour before
// the newest kept snapshot, so nothing a run is writing right now can be taken.
import { keepSet, referencedIds } from './retention.js'

const GRACE_MS = 60 * 60 * 1000

export async function pruneRepo(repo, { now = Date.now() } = {}) {
  const readable = []
  let unreadable = 0
  for (const name of await repo.listSnapshots()) {
    const manifest = await repo.readSnapshot(name)
    if (manifest) readable.push({ name, manifest, createdAt: Date.parse(manifest.createdAt), suspect: !!manifest.suspect })
    else unreadable++
  }
  if (!readable.length) return { snapshots: 0, objects: 0 }
  const newest = readable.reduce((a, b) => (b.createdAt > a.createdAt ? b : a))
  const keep = keepSet(readable, now, newest.manifest.departures ?? [])
  let snapshots = 0
  const referenced = new Set()
  let newestKept = 0
  for (const snap of readable) {
    if (keep.has(snap.name)) {
      for (const id of referencedIds(snap.manifest)) referenced.add(id)
      newestKept = Math.max(newestKept, snap.createdAt)
    } else {
      await repo.deleteSnapshot(snap.name)
      snapshots++
    }
  }
  let objects = 0
  if (unreadable) return { snapshots, objects }
  for (const id of await repo.objectIds()) {
    if (referenced.has(id)) continue
    if ((await repo.objectMtime(id)) > newestKept - GRACE_MS) continue
    await repo.deleteObject(id)
    objects++
  }
  return { snapshots, objects }
}
