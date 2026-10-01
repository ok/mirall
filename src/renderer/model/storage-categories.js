// The Storage screen's rows, in the order a person can act on them: each space (freed by leaving
// it), what Mirall frees on its own, then the fixed rest. Joins the worker's measurement with main's
// app update store; the total is the whole data folder.
/** @import { StorageInfo, SpaceStorageUsage } from '../types/types.js' */
/** @import { UpdateCacheInfo } from '../platform/global.js' */

export const STORAGE_CATEGORY = Object.freeze({
  SPACES: 'spaces',
  INDEX: 'index',
  ACTIVITY: 'activity-log',
  DOWNLOADS: 'download-history',
  UPDATES: 'updates',
  OTHER: 'other',
})
/** @typedef {(typeof STORAGE_CATEGORY)[keyof typeof STORAGE_CATEGORY]} StorageCategoryId */

/**
 * @typedef {{ id: StorageCategoryId, bytes: number }} StorageCategoryRow
 * @typedef {{ total: number, spaces: SpaceStorageUsage[], categories: StorageCategoryRow[], reclaimable: number, showFreeUp: boolean }} StorageCategories
 */

/** @param {SpaceStorageUsage} space */
export const spaceBytes = (space) => space.ownCatalogBytes + space.memberCatalogBytes

/**
 * `categories` holds every category but the spaces' own rows, Spaces first as their sum, so a meter
 * draws one segment per category.
 * @param {StorageInfo | null | undefined} info
 * @param {UpdateCacheInfo | null | undefined} updates
 * @returns {StorageCategories}
 */
export function storageCategories(info, updates) {
  if (!info) return { total: 0, spaces: [], categories: [], reclaimable: 0, showFreeUp: false }
  const updateBytes = updates?.bytes ?? 0
  const total = Math.max(info.folderBytes, info.totalDiskUsage + updateBytes)
  // Keys, settings, logs and the renderer's caches sit in the data folder beside the store; old
  // versions of Mirall's own records are counted with them, since no one acts on them by name.
  const outside = Math.max(0, total - info.totalDiskUsage - updateBytes)
  const categories = [
    { id: STORAGE_CATEGORY.SPACES, bytes: info.spaces.reduce((n, s) => n + spaceBytes(s), 0) },
    { id: STORAGE_CATEGORY.INDEX, bytes: info.indexBytes },
    { id: STORAGE_CATEGORY.ACTIVITY, bytes: info.activityLogBytes },
    { id: STORAGE_CATEGORY.DOWNLOADS, bytes: info.downloadHistoryBytes },
    { id: STORAGE_CATEGORY.UPDATES, bytes: updateBytes },
    { id: STORAGE_CATEGORY.OTHER, bytes: info.otherBytes + info.historyBytes + outside },
  ]
  const reclaimable = info.reclaimableBytes + (updates?.reclaimableBytes ?? 0)
  return { total, spaces: info.spaces, categories, reclaimable, showFreeUp: reclaimable >= info.freeUpMinBytes }
}
