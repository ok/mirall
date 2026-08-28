// Turns a work item into catalog + overlay effects. Every item re-derives its precondition from
// CURRENT state at execution time, never from the facts it was enqueued with: an item can sit in
// the lane for minutes, and in that time the mount may have been relocated or its root unplugged.
import fs from 'bare-fs'
import { OP, PRIORITY } from './work-item.js'
import { getOwnedMount } from './mount-store.js'
import { fileExactlyPresent } from './disk-presence.js'
import { pathFromMount } from '../transfer/path-guard.js'
import { getContentBackend, isUnsupportedShare } from '../transfer/content-backends.js'

export function mountRootAvailable(mountPath) {
  try {
    return fs.statSync(mountPath).isDirectory()
  } catch {
    return false
  }
}

// `catalogFor(spaceId)` is the space's catalog batch (created on demand); `settleCatalog(spaceId)`
// lands everything it holds, including a flush already in flight.
export function createPublishRunner({ loadShare, catalogFor, settleCatalog }) {
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

    // Bulk items write through the space's catalog batch (few atomic heads for the consumer). An
    // interactive item goes direct so a dropped-in file is visible within milliseconds — after
    // landing whatever the batch still holds for the space, so a staged put or tombstone for the
    // same path can never land after the direct write and undo it.
    const interactive = item.priority === PRIORITY.INTERACTIVE
    if (interactive) await settleCatalog(item.spaceId)
    const catalog = interactive ? undefined : catalogFor(item.spaceId)

    if (item.op === OP.RETIRE) {
      // Absence from a stale observation is a candidate; only a file that is really gone — under
      // exactly this name — is a delete. A tombstone replicates to every peer. A relPath that
      // escapes the mount is catalog poison, not a file — reclaim it.
      if (absPath && fileExactlyPresent(absPath)) return { outcome: 'skipped-still-present' }
      await backend.publishDelete(item.spaceId, share, item.relPath, { catalog })
      return { outcome: 'retired' }
    }
    if (!absPath) return { outcome: 'failed' }

    const changed = await backend.publishAdd(item.spaceId, share, item.relPath, absPath, {
      signal: item.signal,
      deep: item.deep,
      catalog,
    })
    return { outcome: changed ? 'published' : 'unchanged' }
  }
}
