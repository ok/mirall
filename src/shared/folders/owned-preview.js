// The owner's read-only scan preview: what publishing this folder would upload, and which of
// those files the catalog already carries under different bytes. Reads nothing the publish engine
// owns — no queue, no scheduler — so it lives outside it.
import path from 'bare-path'
import { listOwnShare } from '../shares/share-catalog.js'
import { overlayHashFile } from '../transfer/backends/overlay/overlay-backend.js'
import { getMaxFilesPerShare } from '../core/runtime-config.js'
import { driveKeyToSegments } from './path-keys.js'
import { exceedsShareFileLimit } from './share-limits.js'
import { createPreviewTally } from './preview-tally.js'
import { walkDisk } from './walk-disk.js'

export async function previewInitialPublishScan(spaceId, shareId, mountPath, ignore, opts = {}) {
  // Catalog side only matters when re-previewing an existing share (relocate). The
  // Add-Folder UI passes shareId=null → onCatalog empty → a pure stat-only walk.
  const onCatalog = new Map()
  if (shareId) {
    for await (const entry of listOwnShare(spaceId, shareId)) onCatalog.set(entry.relPath, entry)
  }

  const { onDisk } = await walkDisk(mountPath, ignore, { onProgress: opts.onProgress, signal: opts.signal })

  const tally = createPreviewTally()
  for (const [relPath, info] of onDisk) {
    const existing = onCatalog.get(relPath)
    let conflict = false
    if (existing) {
      if (existing.size === info.size && existing.mtime === info.mtime) continue
      if (existing.size !== info.size) {
        conflict = true
      } else {
        // Same size, different mtime: only a content hash can tell a real edit
        // from a touch. Compare with the overlay hasher (catalog hashes are
        // leaf/size-prefixed, not plain blake2b).
        const abs = path.join(mountPath, ...driveKeyToSegments(relPath))
        let diskHash = null
        try { diskHash = await overlayHashFile(abs) } catch { diskHash = null }
        if (diskHash != null && existing.contentHash != null && existing.contentHash === diskHash) continue
        conflict = true
      }
    }
    tally.add({ relPath, size: info.size, conflict })
  }

  // The limit is about how many files the folder HOLDS, not how many this scan would upload —
  // a re-preview of an existing share uploads only the changed ones.
  const totalFiles = onDisk.size
  return tally.result('add-owned-folder', 'upload', {
    existingAtDestination: totalFiles,
    totalFiles,
    fileLimit: getMaxFilesPerShare(),
    overFileLimit: exceedsShareFileLimit(totalFiles),
  })
}
