// The options of a forced full-range RocksDB compaction, the pass every reclaim ends in: blob garbage
// collection frees the blocks a clear, truncate or purge left, and `exclusive` blocks background
// compactions for its duration, so none can drop a tombstone before its blob is accounted. One copy
// for the worker's store and main's update store.
export const FORCED_COMPACTION = Object.freeze({
  exclusive: true,
  blobGarbageCollectionPolicy: 1,
  blobGarbageCollectionAgeCutoff: 1.0,
  bottommostLevelCompaction: 2,
})
