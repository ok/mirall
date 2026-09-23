// Storage accounting behind the Storage screen: measure the store's disk footprint (overlay index,
// database remainder), plus the boot-time metadata sweep.
import fs from 'bare-fs'
import path from 'bare-path'
import { createLogger } from '../core/logger.js'
import { getStoragePath } from '../core/store.js'
import { purgeLeftovers } from './leftover.js'

const log = createLogger('storage')

function getDirSize(dirPath) {
  let size = 0
  try {
    const entries = fs.readdirSync(dirPath)
    for (const entry of entries) {
      const full = path.join(dirPath, entry)
      const stat = fs.statSync(full)
      if (stat.isDirectory()) {
        size += getDirSize(full)
      } else {
        size += stat.size
      }
    }
  } catch (err) {
    log.warn('cannot stat:', dirPath, err.message)
  }
  return size
}

export async function getStorageInfo() {
  const totalDiskUsage = getDirSize(getStoragePath())
  let indexBytes = 0
  try {
    const { getOverlayLocalByteLength } = await import('../transfer/backends/overlay/overlay-instance.js')
    indexBytes = await getOverlayLocalByteLength()
  } catch (err) { log.warn('overlay index size failed:', err.message) }
  return {
    totalDiskUsage,
    storagePath: getStoragePath(),
    indexBytes,
    dbBytes: Math.max(0, totalDiskUsage - indexBytes),
  }
}

// Boot sweep. Prunes leftover peer metadata (profile and catalog bee cores no longer tied to any
// active space) — never system bees or any raw blob core.
//
// The deletes are irreversible, so the go/no-go is sweep/sweep-rules.js and it fails closed: any gap
// in the scan refuses the WHOLE sweep, and past a floor the target set is refused above an
// absolute cap or a fraction of the store. Every pass, allowed or refused, is journaled. Metadata
// tombstones are collected by whatever compaction happens next: blocking every boot on a full-range
// pass is not acceptable.
export async function cleanupOrphanedData() {
  const { purged, refused } = await purgeLeftovers({ compact: false })
  if (refused) {
    log.warn('leftover metadata cleanup skipped this boot:', refused)
    return { purged: 0, refused }
  }
  log.info('leftover metadata cleanup done, pruned', purged, 'cores')
  return { purged, refused: null }
}
