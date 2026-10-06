// The update cache: the pear-runtime store keeps every app version it ever fetched, and only the
// latest is ever read again (the running app runs from disk, a staged update from pear-runtime/next).
// A prune clears every blob block the latest version's files for this platform do not reference, then
// compacts that store so the bytes leave the disk. Reads never wait on the network: a version whose
// entries are not all local is left whole. Callers serialize a prune with the update passes.
//
// No Electron here, so a Node test drives it against a real updater.
const fs = require('fs')
const path = require('path')
const { keptRanges, clearableGaps, keptBytes } = require('./update-cache-ranges.js')
const { FORCED_COMPACTION } = require('../shared/contract/compaction.js')

const LOCAL = { wait: false }

// The blob core length and kept ranges of the last prune that ran to the end. The same pair again has
// nothing new to clear, which spares a walk over every block no earlier prune kept.
let lastPruned = null

let compactionTail = Promise.resolve()

// Chained like the worker's compactStore: two overlapping blob-GC compactions can strand a blob.
function compactUpdateStore(store) {
  const run = compactionTail.catch(() => {}).then(async () => {
    const db = store.storage.db
    await db.flush()
    await db.compactRange(null, null, FORCED_COMPACTION)
  })
  compactionTail = run
  return run
}

// The blobs the latest version keeps for this platform: its manifest and every file under `prefix`.
// Null when any of it is not on this device, which leaves the cache alone.
async function latestBlobs(drive, blobs, prefix) {
  const co = drive.checkout(drive.core.length)
  try {
    const entries = [await co.entry('/package.json', LOCAL), await co.entry(prefix, LOCAL)]
    for await (const entry of co.list(prefix, LOCAL)) entries.push(entry)
    const kept = []
    for (const entry of entries) {
      const blob = entry?.value?.blob
      if (!blob) continue
      if (!(await blobs.core.has(blob.blockOffset, blob.blockOffset + blob.blockLength))) return null
      kept.push({ ...blob, mapBlocks: blob.blockMap ? (await blobs.getBlockMap(blob)).blocks : [] })
    }
    return kept.length > 1 ? kept : null
  } catch (err) {
    if (err.code === 'BLOCK_NOT_AVAILABLE') return null
    throw err
  } finally {
    await co.close()
  }
}

// clear() reports nothing it removed, so the present blocks are counted before it runs.
async function presentBlocks(core, start, end) {
  if (await core.has(start, end)) return end - start
  let present = 0
  for (let i = start; i < end; i++) if (await core.has(i)) present++
  return present
}

async function pruneUpdateCache({ updater, prefix, log = null }) {
  const drive = updater?.drive
  if (!drive?.core.length) return { clearedBlocks: 0 }
  const blobs = await drive.getBlobs()
  const kept = await latestBlobs(drive, blobs, prefix)
  if (!kept) return { clearedBlocks: 0 }
  const ranges = keptRanges(kept)
  const mark = JSON.stringify([blobs.core.length, ranges])
  if (mark === lastPruned) return { clearedBlocks: 0 }
  let clearedBlocks = 0
  for (const [start, end] of clearableGaps(ranges, blobs.core.length)) {
    const present = await presentBlocks(blobs.core, start, end)
    if (!present) continue
    await blobs.core.clear(start, end)
    clearedBlocks += present
  }
  if (clearedBlocks > 0) {
    await compactUpdateStore(updater.store)
    log?.info('update cache pruned', clearedBlocks, 'blocks')
  }
  lastPruned = mark
  return { clearedBlocks }
}

// A symlink counts as itself and is never followed, and an entry that cannot be read is skipped
// alone: the data folder holds Chromium's dangling Singleton* links.
async function dirSize(dir) {
  let names
  try { names = await fs.promises.readdir(dir) } catch { return 0 }
  let size = 0
  for (const name of names) {
    const full = path.join(dir, name)
    try {
      const stat = await fs.promises.lstat(full)
      size += stat.isDirectory() ? await dirSize(full) : stat.size
    } catch {}
  }
  return size
}

// The pear-runtime folder on disk, and about how much of its store a prune would free: the store less
// what the latest version keeps for this platform.
async function updateCacheInfo({ updater, dataDir, prefix }) {
  const root = path.join(dataDir, 'pear-runtime')
  const bytes = await dirSize(root)
  const drive = updater?.drive
  if (!drive?.core.length) return { bytes, reclaimableBytes: 0 }
  const kept = await latestBlobs(drive, await drive.getBlobs(), prefix)
  if (!kept) return { bytes, reclaimableBytes: 0 }
  return { bytes, reclaimableBytes: Math.max(0, await dirSize(path.join(root, 'corestore')) - keptBytes(kept)) }
}

module.exports = { pruneUpdateCache, updateCacheInfo, dirSize }
