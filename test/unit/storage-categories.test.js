import test from 'brittle'
import { storageCategories, STORAGE_CATEGORY } from '../../src/renderer/model/storage-categories.js'

const info = (over = {}) => ({
  totalDiskUsage: 0, storagePath: '/d/app-storage', folderBytes: 0, folderPath: '/d', host: 'daemon',
  spaces: [], indexBytes: 0, activityLogBytes: 0, downloadHistoryBytes: 0, historyBytes: 0, otherBytes: 0,
  historyMeasuredAt: null, reclaimableBytes: 0, freeUpMinBytes: 100e6, ...over,
})

test('the measured install shows Free up, with one segment per category in the order a person acts on them', (t) => {
  const r = storageCategories(info({
    totalDiskUsage: 730e6,
    folderBytes: 2.735e9,
    spaces: [
      { spaceId: 'a', name: 'A', ownCatalogBytes: 1e6, memberCatalogBytes: 0.2e6 },
      { spaceId: 'b', name: 'B', ownCatalogBytes: 0.5e6, memberCatalogBytes: 0.2e6 },
    ],
    indexBytes: 46.6e6, activityLogBytes: 2.4e6, downloadHistoryBytes: 1e6, historyBytes: 625e6, otherBytes: 53.1e6,
    historyMeasuredAt: 1, reclaimableBytes: 625e6,
  }), { bytes: 2.0e9, reclaimableBytes: 1.73e9 })
  t.is(r.total, 2.735e9, 'the whole data folder')
  t.alike(r.categories.map((x) => x.id), Object.values(STORAGE_CATEGORY))
  t.is(r.categories[0].bytes, 1.9e6, 'Spaces is their sum')
  t.is(r.categories[4].bytes, 2.0e9, 'app updates come from main')
  t.is(r.categories[5].bytes, 53.1e6 + 625e6 + 5e6, 'other takes the store remainder, old record versions and the rest of the folder')
  t.is(r.reclaimable, 625e6 + 1.73e9)
  t.ok(r.showFreeUp)
})

test('under the threshold there is no Free up; at it there is', (t) => {
  t.absent(storageCategories(info({ reclaimableBytes: 60e6 }), { bytes: 0, reclaimableBytes: 39e6 }).showFreeUp)
  t.ok(storageCategories(info({ reclaimableBytes: 60e6 }), { bytes: 0, reclaimableBytes: 40e6 }).showFreeUp)
})

test('a zero threshold always offers Free up', (t) => {
  t.ok(storageCategories(info({ freeUpMinBytes: 0 }), null).showFreeUp)
})

test('no info yet: nothing to show', (t) => {
  t.alike(storageCategories(null, null), { total: 0, spaces: [], categories: [], reclaimable: 0, showFreeUp: false })
})

test('a folder read that lags the store never makes the total smaller than its parts', (t) => {
  const r = storageCategories(info({ totalDiskUsage: 100, folderBytes: 50 }), { bytes: 30, reclaimableBytes: 0 })
  t.is(r.total, 130)
  t.is(r.categories[5].bytes, 0, 'nothing outside the store and the updates')
})
