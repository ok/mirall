// Turns a work item into catalog + overlay effects. Every item re-derives its precondition from
// CURRENT state at execution time, never from the facts it was enqueued with: an item can sit in
// the lane for minutes, and in that time the mount may have been relocated or its root unplugged.
import fs from 'bare-fs'
import { OP, PRIORITY } from './work-item.js'
import { getOwnedMount } from './mount-store.js'
import { pathFromMount } from '../transfer/path-guard.js'
import { getContentBackend, isUnsupportedShare } from '../transfer/content-backends.js'

export function mountRootAvailable(mountPath) {
  try {
    return fs.statSync(mountPath).isDirectory()
  } catch {
    return false
  }
}

function stillOnDisk(absPath) {
  try {
    return fs.statSync(absPath).isFile()
  } catch {
    return false
  }
}

export function createPublishRunner({ loadShare, catalogFor }) {
  return async function execute(item) {
    const mount = await getOwnedMount(item.spaceId, item.shareId)
    if (!mount) return { outcome: 'skipped-unmounted' }
    // A missing root is ambiguous (unplugged, offline) and never a delete. When a root vanishes
    // chokidar emits one unlink per file, and every one of them lands here.
    if (!mountRootAvailable(mount.mountPath)) return { outcome: 'skipped-root-gone' }
    const share = await loadShare(item.spaceId, item.shareId)
    if (!share || isUnsupportedShare(share)) return { outcome: 'skipped' }
    const backend = getContentBackend(share)

    let absPath = null
    try { absPath = pathFromMount(mount.mountPath, item.relPath) } catch {}

    if (item.op === OP.RETIRE) {
      // Absence from a stale observation is a candidate; only a file that is really gone is a
      // delete. A tombstone replicates to every peer. A relPath that escapes the mount is catalog
      // poison, not a file — reclaim it.
      if (absPath && stillOnDisk(absPath)) return { outcome: 'skipped-still-present' }
      await backend.publishDelete(item.spaceId, share, item.relPath)
      return { outcome: 'retired' }
    }
    if (!absPath) return { outcome: 'failed' }

    // Bulk items write through the space's catalog batch (few atomic heads for the consumer); an
    // interactive item goes direct so a dropped-in file is visible within milliseconds.
    const catalog = item.priority === PRIORITY.INTERACTIVE ? undefined : catalogFor(item.spaceId)
    const changed = await backend.publishAdd(item.spaceId, share, item.relPath, absPath, {
      signal: item.signal,
      deep: item.deep,
      catalog,
    })
    return { outcome: changed ? 'published' : 'unchanged' }
  }
}
