// The serve side's chunk source: a tracked fd per (peer, file) serve session, read with positioned
// async reads, so a 4 MiB tier-3 read never blocks the worker loop.

import { openTracked, closeTracked, readFully } from './fd-accounting.js'

export async function openChunkSource(filePath) {
  try { return await openTracked(filePath, 'r') } catch { return null }
}

export function closeChunkSource(fd) {
  return closeTracked(fd)
}

// The chunk bytes, or null on a short read or any error (a closed fd included). allocUnsafe is
// safe because a partially filled buffer is never returned.
export async function readChunkAt(fd, offset, length) {
  const buf = Buffer.allocUnsafe(length)
  try {
    return (await readFully(fd, buf, length, offset)) === length ? buf : null
  } catch {
    return null
  }
}
