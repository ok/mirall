// Keeps serveIndex and the overlay's path map in lockstep: a file is servable by its content hash
// only while both hold it. The index refcounts by (space, share, path), so content-addressed dedup
// (two paths, one hash) survives a per-path delete. A servable is
// { spaceId, shareId, relPath, absPath, contentHash, size }.
import { getOverlay } from './overlay-instance.js'
import { serveIndex } from './overlay-serve-index.js'
import { createLogger } from '../../../core/logger.js'

const log = createLogger('overlay')

// Registers lazily: the path+hash now, the chunk map on the first peer fetch. registerFile returns
// null when the source vanished at register time, and a serve nothing can back is never claimed.
export async function makeServable({ spaceId, shareId, relPath, absPath, contentHash, size }) {
  const overlay = getOverlay()
  if (!overlay) return
  const registered = await overlay.registerFile('/mir/' + contentHash, absPath, { contentHash, size, prepare: false })
  if (!registered) return
  serveIndex.add(contentHash, spaceId, shareId, relPath)
}

// The reconcile's self-heal for a file it will not re-publish: free while the reference is held.
export async function ensureServable(servable) {
  const { contentHash, spaceId, shareId, relPath } = servable
  if (serveIndex.hasRef(contentHash, spaceId, shareId, relPath)) return
  await makeServable(servable)
}

// Drops this path's reference; the durable chunk map goes only with the last one.
export async function evictIfUnreferenced({ contentHash, spaceId, shareId, relPath }) {
  if (!contentHash) return
  if (!serveIndex.remove(contentHash, spaceId, shareId, relPath)) return
  try { await getOverlay()?.evictContent(contentHash) } catch (err) { log.warn('evictContent failed:', err.message) }
}
