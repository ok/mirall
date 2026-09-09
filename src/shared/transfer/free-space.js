// Whether a volume can hold what a transfer is about to write. Pure, so the arithmetic is asserted
// directly rather than through a live filesystem — the probe itself stays with the caller, which is
// what keeps this Node-loadable.
//
// It lived inside createOverlayDownloadEngine, so the mirror could not reach it and learned about a
// full disk only by failing a write — by which point the volume is already at zero and the worker's
// own bee writes are at risk.

// Headroom beyond the file itself: the journal, rocksdb writes and the OS all need working space,
// and filling the volume to the last byte wedges more than the transfer.
export const FREE_SPACE_HEADROOM = 64 * 1024 * 1024

// Bytes still needed after what a resumed partial already allocated, or 0 when it fits. Fails OPEN
// on an unmeasurable volume: a probe error must never block a transfer, and the write itself still
// surfaces a real ENOSPC.
export function shortfall({ freeBytes, needBytes, allocatedBytes = 0, headroom = FREE_SPACE_HEADROOM }) {
  if (!Number.isFinite(freeBytes)) return 0
  const needed = Math.max(0, needBytes - allocatedBytes) + headroom
  return Math.max(0, needed - freeBytes)
}
