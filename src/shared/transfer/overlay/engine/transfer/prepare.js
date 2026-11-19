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
import { prepareOnThreads } from './prepare-threaded.js'

// The read block adapts to the host's memory; it is at least the tier's largest chunk.
const READ_BLOCK_DEFAULT = 8 * 1024 * 1024
const READ_BLOCK_LOW_RAM = 4 * 1024 * 1024
const LOW_RAM_THRESHOLD = 6 * 1024 * 1024 * 1024

export function hostReadBlock() {
  return os.totalmem() < LOW_RAM_THRESHOLD ? READ_BLOCK_LOW_RAM : READ_BLOCK_DEFAULT
}
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

// The pass on the worker thread: { chunks, bytes, contentHash } for one job.
async function prepareOnWorkerThread(job) {
  const fileHasher = createStreamingHasher({ size: job.size })
  const chunks = []
  for await (const c of chunkStream(readFileBlocks(job.filePath, job.size, job.blockSize), { tier: job.tier, copy: false })) {
    if (job.signal?.aborted) throw codedError('publish aborted', 'ECANCELLED')
    fileHasher.update(c.data)
    chunks.push({ hash: c.hash, offset: c.offset, length: c.length })
    job.onProgress?.(c.length)
  }
  return { chunks, bytes: fileHasher.bytes, contentHash: fileHasher.digest() }
}

// Progress that stays silent for the first `skip` bytes: a pass repeated from the file's start
// reports only what the first attempt had not.
function progressAfter(skip, onProgress) {
  let left = skip
  return (bytes) => {
    const held = Math.min(left, bytes)
    left -= held
    if (bytes > held) onProgress(bytes - held)
  }
}

// A file of at least one read block is hashed on the hash threads when the caller has them. When
// they are unavailable or stop mid-file, the file is prepared from its start on the worker thread:
// the threads only make the pass faster, and a share never fails or gets a partial result for them.
async function readPass(job, hashThreads) {
  if (!hashThreads || job.size < job.blockSize || job.blockSize > hashThreads.blockSize) return prepareOnWorkerThread(job)
  let reported = 0
  const onProgress = job.onProgress && ((bytes) => { reported += bytes; job.onProgress(bytes) })
  const threaded = await prepareOnThreads(hashThreads, { ...job, onProgress })
  if (threaded) return threaded
  return prepareOnWorkerThread({ ...job, onProgress: job.onProgress && progressAfter(reported, job.onProgress) })
}

// { tier, chunks, size, contentHash }, or null when the source is missing, not a file, or changed
// or vanished during the read (the caller re-queues). Cut points are content-stable across block
// sizes, and the hasher is given the size so the streaming digest matches hashChunk(buffer).
// opts.signal aborts per chunk; opts.onProgress(bytes) reports each one, in file order.
// opts.hashThreads moves the hashing of a large file off this thread. opts.tier overrides the
// tier the size selects, for a test of a large file's chunk sizes on a small file.
export async function prepareForServe(fileIndex, filePath, opts = {}) {
  let stat
  try { stat = fs.statSync(filePath) } catch { return null }
  if (!stat.isFile()) return null
  const mtimeBefore = stat.mtimeMs
  const tier = opts.tier ?? selectTier(stat.size)
  const blockSize = Math.max(getTierParams(tier).maxSize, hostReadBlock())
  const job = { filePath, size: stat.size, tier, blockSize, signal: opts.signal, onProgress: opts.onProgress }
  const pass = await readPass(job, opts.hashThreads)
  // The open fd keeps a read alive across a same-volume rename, so it is this path stat that sees
  // a source moved away mid-read.
  let statAfter
  try { statAfter = fs.statSync(filePath) } catch { return null }
  if (statAfter.mtimeMs !== mtimeBefore) return null
  // A mid-read shrink feeds the digest fewer bytes than the size in its leaf prefix.
  if (pass.bytes !== stat.size) return null
  const { chunks, contentHash } = pass
  if (stat.size >= PERSIST_MAP_MIN_BYTES && !await fileIndex.hasChunkMapByHash(contentHash)) {
    await fileIndex.putChunkMapByHash(contentHash, chunks)
  }
  return { tier, chunks, size: stat.size, contentHash }
}
