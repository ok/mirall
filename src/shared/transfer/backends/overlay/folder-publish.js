// The folder share's publish side of the overlay content-backend contract: publishAdd /
// publishDelete over the shared publish core, the deep-scan verdict, and the owner's view refresh.
import fs from 'bare-fs'
import { shareDecoKey } from '../../../contract/decoration-key.js'
import { ownCatalogWriter, setOwnCatalogAppendHook } from '../../../shares/own-catalog.js'
import { makeSharesRefresh } from './overlay-refresh.js'
import { publishContent, retireContent } from './overlay-publish.js'
import { overlayHashFile } from './overlay-hash.js'
import { makeServable } from './serve-registration.js'
import { makePublishProgress } from './publish-progress.js'

let ipcRef = null
const sharesRefresh = makeSharesRefresh(
  (spaceId, shareId) => ipcRef?.emit('event:share-files-updated', { spaceId, shareId }),
)

export function initFolderPublish({ ipc }) {
  ipcRef = ipc
  // The owner's level trigger. A catalog append is the one owner-side signal that cannot fire ahead
  // of the write it announces, which is exactly what publishOne's advertise-time touch cannot
  // promise for a batched publish. Wildcarded on the share axis (no shareId): ONE catalog backs
  // every share in the space plus the loose channel, so an append names no single share.
  setOwnCatalogAppendHook((spaceId) => sharesRefresh.touch(spaceId, undefined))
}

export function resetFolderPublish() {
  ipcRef = null
  setOwnCatalogAppendHook(null)
  sharesRefresh.reset()
}

export async function folderPublishAdd(spaceId, share, relPath, absPath, opts = {}) {
  try {
    return await publishOne(spaceId, share, relPath, absPath, opts)
  } finally {
    // Refresh on success AND on a reverted failure (publishContent undoes the half-advertised
    // entry on throw). A batched bulk publish coalesces; a direct one flushes now.
    if (opts.catalog) sharesRefresh.touch(spaceId, share.id)
    else sharesRefresh.flush(spaceId, share.id)
  }
}

// A bulk retire writes through the space's catalog batch like a bulk publish (one head for a
// thousand deletions, not a thousand), so the eviction is off the executor's critical path.
export async function folderPublishDelete(spaceId, share, relPath, { catalog = ownCatalogWriter } = {}) {
  await retireContent(spaceId, share.id, relPath, { catalog })
  if (catalog === ownCatalogWriter) sharesRefresh.flush(spaceId, share.id)
  else sharesRefresh.touch(spaceId, share.id)
}

// One file, no view-refresh emit (callers batch that). The terminal decoration fires in a finally,
// on success AND throw, so a failed hash can't strand a preparing bar.
async function publishOne(spaceId, share, relPath, absPath, { catalog = ownCatalogWriter, signal, deep = false, beat } = {}) {
  const progress = makePublishProgress({ spaceId, shareId: share.id, relPath, decoKey: shareDecoKey(share.id, relPath) })
  try {
    let force = false
    if (deep) {
      const verdict = await deepVerdict({ spaceId, share, relPath, absPath }, { catalog, signal, beat })
      beat?.()
      if (verdict === 'unchanged') return false
      force = verdict === 'changed'
    }
    const { changed } = await publishContent(spaceId, share.id, relPath, absPath, {
      catalog,
      signal,
      force,
      // Refresh the owner's view NOW (the `publishing` row) — the same instant the consumer's
      // peer-catalog append surfaces it.
      onAdvertised: (size) => { sharesRefresh.touch(spaceId, share.id); progress.onAdvertised(size) },
      onProgress: (len) => { progress.onProgress(len); beat?.() },
    })
    return changed
  } finally {
    progress.done()
  }
}

// Deep-scan (relocate, the Nth periodic pass) verdict for one file, by content hash:
//   'unchanged' — same size + same hash: serving is re-pointed at the path, a drifted mtime is
//                 refreshed without re-advertising (no mirror churn), and the publish is skipped;
//   'changed'   — same size, different hash: an in-place rewrite. The publish MUST run even when
//                 the mtime is unchanged too (the fast path would call that "already published");
//   'unknown'   — nothing to compare against (no hash yet, size differs, unreadable): the
//                 ordinary size+mtime publish decides.
// The beat rides the hash's own per-chunk callback: on a large file the hash is the longest phase
// of a deep pass by far, and a phase that reports nothing reads as wedged — the recovery for a
// wedged item aborts the signal this hash polls per chunk, killing the very work making progress.
async function deepVerdict({ spaceId, share, relPath, absPath }, { catalog, signal, beat }) {
  let st
  try { st = fs.statSync(absPath) } catch { return 'unknown' }
  const prev = await catalog.get(spaceId, share.id, relPath)
  if (!prev?.contentHash || prev.size !== st.size) return 'unknown'
  let diskHash
  try { diskHash = await overlayHashFile(absPath, beat, signal) } catch (err) {
    if (err?.code === 'ECANCELLED') throw err
    return 'unknown'
  }
  if (diskHash !== prev.contentHash) return 'changed'
  await makeServable({ spaceId, shareId: share.id, relPath, absPath, contentHash: prev.contentHash, size: st.size })
  if (prev.mtime !== st.mtimeMs) await catalog.advertise(spaceId, share.id, relPath, { size: st.size, mtime: st.mtimeMs, contentHash: prev.contentHash })
  return 'unchanged'
}
