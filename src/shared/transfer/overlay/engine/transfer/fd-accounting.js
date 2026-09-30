// Every descriptor this engine opens is counted here. The leak tests cannot use the process fd
// table as their oracle — `brittle-bare -j` runs test files as threads in one process, so sibling
// files' descriptors pollute any snapshot of it — so they assert on the descriptors the engine
// owns. A close that throws leaves the fd open, so it does not decrement.

import fs from 'bare-fs'

let openFds = 0

/** @internal */
export const openFdCount = () => openFds

export async function openTracked(filePath, flags) {
  const fd = await fs.open(filePath, flags)
  openFds++
  return fd
}

export function openSyncTracked(filePath, flags) {
  const fd = fs.openSync(filePath, flags)
  openFds++
  return fd
}

// Read `length` bytes at `position` into `buf`, looping over short reads, and return how many
// landed: fewer than asked only at end of file. A single fs.read may return short without an error.
export async function readFully(fd, buf, length, position, offset = 0) {
  let filled = 0
  while (filled < length) {
    const n = await fs.read(fd, buf, offset + filled, length - filled, position + filled)
    if (n <= 0) break
    filled += n
  }
  return filled
}

export async function closeTracked(fd) {
  try { await fs.close(fd) } catch { return }
  openFds--
}

export function closeSyncTracked(fd) {
  try { fs.closeSync(fd) } catch { return }
  openFds--
}
