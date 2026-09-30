// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/transfer.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// Chunk and hash a source file in one block-read pass, and persist its content-addressed map.

import fs from 'bare-fs'
import os from 'bare-os'
import { chunkStream, createStreamingHasher, selectTier, getTierParams } from '../chunker.js'
import { codedError } from '../local-faults.js'
import { openTracked, closeTracked, readFully } from './fd-accounting.js'

// The read block adapts to the host's memory; it is at least the tier's largest chunk.
const READ_BLOCK_DEFAULT = 8 * 1024 * 1024
const READ_BLOCK_LOW_RAM = 4 * 1024 * 1024
const LOW_RAM_THRESHOLD = 6 * 1024 * 1024 * 1024
// A map is persisted at prepare time only for files this large; the serve path persists the rest.
const PERSIST_MAP_MIN_BYTES = 1048576

// File blocks of at least the tier's largest chunk, so chunkStream drains every block instead of
// re-copying a growing pending buffer. Owns its fd and closes it on every terminal path: normal
// end, a consumer's break or throw (for-await calls .return()), a read error.
async function * readFileBlocks(filePath, size, blockSize) {
  const fd = await openTracked(filePath, 'r')
  try {
    let pos = 0
    while (pos < size) {
      const want = Math.min(blockSize, size - pos)
      const buf = Buffer.allocUnsafe(want)
      const filled = await readFully(fd, buf, want, pos)
      if (filled === 0) break
      pos += filled
      yield filled === buf.length ? buf : buf.subarray(0, filled)
    }
  } finally {
    await closeTracked(fd)
  }
}

// { tier, chunks, size, contentHash }, or null when the source is missing, not a file, or changed
// or vanished during the read (the caller re-queues). Cut points are content-stable across block
// sizes, and the hasher is given the size so the streaming digest matches hashChunk(buffer).
// opts.signal aborts per chunk; opts.onProgress(bytes) reports each one.
export async function prepareForServe(fileIndex, filePath, opts = {}) {
  let stat
  try { stat = fs.statSync(filePath) } catch { return null }
  if (!stat.isFile()) return null
  const mtimeBefore = stat.mtimeMs
  const tier = selectTier(stat.size)
  const blockSize = Math.max(getTierParams(tier).maxSize, os.totalmem() < LOW_RAM_THRESHOLD ? READ_BLOCK_LOW_RAM : READ_BLOCK_DEFAULT)
  const fileHasher = createStreamingHasher({ size: stat.size })
  const chunks = []
  for await (const c of chunkStream(readFileBlocks(filePath, stat.size, blockSize), { tier, copy: false })) {
    if (opts.signal?.aborted) throw codedError('publish aborted', 'ECANCELLED')
    fileHasher.update(c.data)
    chunks.push({ hash: c.hash, offset: c.offset, length: c.length })
    opts.onProgress?.(c.length)
  }
  // The open fd keeps a read alive across a same-volume rename, so it is this path stat that sees
  // a source moved away mid-read.
  let statAfter
  try { statAfter = fs.statSync(filePath) } catch { return null }
  if (statAfter.mtimeMs !== mtimeBefore) return null
  // A mid-read shrink feeds the digest fewer bytes than the size in its leaf prefix.
  if (fileHasher.bytes !== stat.size) return null
  const contentHash = fileHasher.digest()
  if (stat.size >= PERSIST_MAP_MIN_BYTES && !await fileIndex.hasChunkMapByHash(contentHash)) {
    await fileIndex.putChunkMapByHash(contentHash, chunks)
  }
  return { tier, chunks, size: stat.size, contentHash }
}
