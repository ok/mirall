// The prepare pass with its hashing on the hash threads. The worker thread reads the file into
// shared slots and finds the chunk boundaries; each block then goes to the content-hash thread and
// to the chunk-hash thread, and its slot is reused once both have answered. The result is the one
// the worker-thread pass produces: the boundary search is the same function over the same bytes.

import { findTierCutPoint, getTierParams } from '../chunker.js'
import { codedError } from '../local-faults.js'
import { openTracked, closeTracked, readFully } from './fd-accounting.js'
import { SLOT_RESERVE } from './hash-threads.js'

// The free list of the shared slots. A slot handed to the threads has two holders and returns
// when both have released it; acquire waits while every slot is out.
function slotPool(count) {
  const free = Array.from({ length: count }, (_, i) => i)
  const holders = new Array(count).fill(0)
  const waiters = []
  const giveBack = (slot) => {
    const waiter = waiters.shift()
    if (waiter) waiter(slot)
    else free.push(slot)
  }
  return {
    acquire() {
      return free.length ? Promise.resolve(free.pop()) : new Promise((resolve) => waiters.push(resolve))
    },
    share(slot) { holders[slot] = 2 },
    release(slot) { if (--holders[slot] === 0) giveBack(slot) },
    giveBack,
  }
}

function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}

// The chunk lengths cut from buf[start, end). Mid-file a cut needs a full largest chunk ahead of
// it; at the end of the file the remainder is cut down to the last chunk.
function cutBlock(buf, start, end, tier, atEnd) {
  const { minSize, maxSize } = getTierParams(tier)
  const keep = atEnd ? minSize : maxSize - 1
  const lens = []
  let at = start
  while (end - at > keep) {
    const len = findTierCutPoint(buf.subarray(at, end), tier)
    lens.push(len)
    at += len
  }
  if (atEnd && end > at) lens.push(end - at)
  return lens
}

// Reads the file block by block, one block ahead of the cut search, and hands every cut block to
// both threads. Chunks are recorded and reported in file order as they are cut.
async function readCutDispatch(run, job, fd) {
  const { threads, pass, guard, slots, out } = run
  const { views, content, chunks } = threads
  let pos = 0
  let offset = 0
  let tailLen = 0
  let seq = 0
  let cur = await guard(slots.acquire())
  let want = Math.min(job.blockSize, job.size - pos)
  run.reading = readFully(fd, views[cur], want, pos, SLOT_RESERVE)
  for (;;) {
    const filled = await run.reading
    pos += filled
    const atEnd = filled < want || pos >= job.size
    let next = -1
    if (!atEnd) {
      next = await guard(slots.acquire())
      want = Math.min(job.blockSize, job.size - pos)
      run.reading = readFully(fd, views[next], want, pos, SLOT_RESERVE)
    }
    const buf = views[cur]
    const start = SLOT_RESERVE - tailLen
    const end = SLOT_RESERVE + filled
    const lens = cutBlock(buf, start, end, job.tier, atEnd)
    const firstChunk = out.chunks.length
    let cutEnd = start
    for (const len of lens) {
      if (job.signal?.aborted) throw codedError('publish aborted', 'ECANCELLED')
      out.chunks.push({ hash: null, offset, length: len })
      offset += len
      cutEnd += len
      job.onProgress?.(len)
    }
    tailLen = end - cutEnd
    if (!atEnd && tailLen > 0) buf.copy(views[next], SLOT_RESERVE - tailLen, cutEnd, end)
    if (lens.length === 0) {
      slots.giveBack(cur)
    } else {
      out.firstChunkOfSeq.set(seq, firstChunk)
      slots.share(cur)
      await guard(content.port.write({ pass, slot: cur, start, len: cutEnd - start }))
      await guard(chunks.port.write({ pass, seq, slot: cur, start, lens }))
      seq++
    }
    if (atEnd) return
    cur = next
  }
}

function listen(run) {
  const { threads, pass, slots, out, done } = run
  threads.content.onMessage = (msg) => {
    if (msg.pass !== pass) return
    if (msg.digest !== undefined) done.content.resolve(msg)
    else slots.release(msg.slot)
  }
  threads.chunks.onMessage = (msg) => {
    if (msg.pass !== pass) return
    if (msg.flushed) return done.chunks.resolve()
    const first = out.firstChunkOfSeq.get(msg.seq)
    out.firstChunkOfSeq.delete(msg.seq)
    for (let i = 0; i < msg.hashes.length; i++) out.chunks[first + i].hash = msg.hashes[i]
    slots.release(msg.slot)
  }
}

// Wraps every wait on a thread so that it rejects when either thread goes: a pass never hangs on
// one. Each wait registers for the fault only while it is pending.
function faultGuard(threads) {
  const pending = new Set()
  threads.onFault = (err) => {
    for (const reject of pending) reject(err)
    pending.clear()
  }
  return (promise) => new Promise((resolve, reject) => {
    if (threads.fault) return reject(threads.fault)
    pending.add(reject)
    promise.then(
      (value) => { pending.delete(reject); resolve(value) },
      (err) => { pending.delete(reject); reject(err) }
    )
  })
}

async function runPass(threads, job) {
  const pass = ++threads.passes
  const run = {
    threads,
    pass,
    guard: faultGuard(threads),
    slots: slotPool(threads.views.length),
    out: { chunks: [], firstChunkOfSeq: new Map() },
    done: { content: deferred(), chunks: deferred() },
    reading: null,
  }
  listen(run)
  Atomics.store(threads.livePass, 0, pass)
  let fd = null
  try {
    await run.guard(threads.content.port.write({ pass, begin: job.size }))
    fd = await openTracked(job.filePath, 'r')
    await readCutDispatch(run, job, fd)
    // Answers come back in the order sent, so these two are behind every block of the pass.
    await run.guard(threads.content.port.write({ pass, end: true }))
    await run.guard(threads.chunks.port.write({ pass, flush: true }))
    const [digest] = await run.guard(Promise.all([run.done.content.promise, run.done.chunks.promise]))
    return { chunks: run.out.chunks, bytes: digest.bytes, contentHash: digest.digest }
  } catch (err) {
    // What is still queued at the threads is skipped; their late answers carry this pass's id and
    // the next pass ignores them.
    Atomics.store(threads.livePass, 0, 0)
    throw err
  } finally {
    // A read still in flight writes into a slot, so the slots are not handed on before it lands.
    if (run.reading) await run.reading.catch(() => {})
    if (fd !== null) await closeTracked(fd)
    threads.content.onMessage = null
    threads.chunks.onMessage = null
    threads.onFault = null
  }
}

// { chunks, bytes, contentHash } for job = { filePath, size, tier, blockSize, signal, onProgress },
// or null when the threads are unavailable or stopped during the pass. Rejects as the
// worker-thread pass does: ECANCELLED on job.signal, a read error as it is.
export function prepareOnThreads(hashThreads, job) {
  return hashThreads.run((threads) => runPass(threads, job))
}
