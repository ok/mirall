// The one statfs both producers ask through. Split from free-space.js so the arithmetic there stays
// Node-loadable; this half is bare-fs and belongs with the callers.
//
// Fails OPEN (Infinity): a probe error must never block a transfer, and the write itself still
// surfaces a real ENOSPC.
import fs from 'bare-fs'

export function freeBytesFor(dir) {
  try {
    const s = fs.statfsSync(dir)
    return s.bavail * s.bsize
  } catch {
    return Infinity
  }
}
