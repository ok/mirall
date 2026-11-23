// The two hash threads of the prepare pass and the block slots they share with the worker thread.
//
// One thread computes the file's content hash, which has to see the bytes in file order; the other
// computes the chunk hashes. Both read blocks from shared memory, so no block is copied or sent.
// A slot is [reserve | block]: the bytes a block leaves uncut are placed in the reserve of the
// next slot, so every slot holds contiguous file bytes. The slot count is fixed, which bounds the
// memory of a pass whatever the file's size or the drive's speed.
//
// The threads start with the first pass that needs them and live until close(). Idle, their
// channels are unreferenced, so they never hold the process open.

import Thread from 'bare-thread'
import Channel from 'bare-channel'
import { TIERS } from '../chunker.js'
import { codedError } from '../local-faults.js'

// The thread entry beside this module, as the file URL bare-thread bundles it from.
const ENTRY = import.meta.url.slice(0, import.meta.url.lastIndexOf('/') + 1) + 'hash-thread.js'
// Room for the uncut remainder of the previous block: always less than the largest chunk.
export const SLOT_RESERVE = Math.max(...TIERS.map((t) => t.maxSize))
// One slot being cut, one being read ahead, and the rest in flight to the threads. A host that
// reads in small blocks is short on memory and gets the minimum that keeps all three busy.
const SLOTS_DEFAULT = 4
const SLOTS_SMALL_BLOCK = 3
const SMALL_BLOCK_BYTES = 4 * 1024 * 1024
// A stopped thread is replaced this many times in a worker's life; after that every pass runs on
// the worker thread.
const MAX_STARTS = 3

// How often a pass waiting for its turn reads its cancel signal, which is a plain boolean.
const TURN_CANCEL_POLL_MS = 50

const cancelled = () => codedError('publish aborted', 'ECANCELLED')

/** The threads went away during a pass; the pass is repeated on the worker thread. */
export class HashThreadsStopped extends Error {}

function openThread(role, bundle, mount, shared) {
  const channel = new Channel()
  const thread = new Thread(bundle, { mount, data: { handle: channel.handle, role, ...shared } })
  const link = { thread, port: channel.connect(), onMessage: null, stopped: null }
  // Resolves with the reason once the thread is gone: it reported an error, or its channel ended.
  link.stopped = (async () => {
    try {
      for await (const msg of link.port) {
        if (msg.error) return new HashThreadsStopped(`${role} hash thread failed: ${msg.error}`)
        link.onMessage?.(msg)
      }
    } catch (err) {
      return new HashThreadsStopped(`${role} hash thread channel failed: ${err.message}`)
    }
    return new HashThreadsStopped(`${role} hash thread stopped`)
  })()
  return link
}

// Referenced first: the close is awaited, and an unreferenced channel does not keep the event
// loop running until it completes.
async function closeLink(link) {
  try {
    link.port.ref()
    await link.port.close()
  } catch {}
}

function startThreads(entry, blockSize) {
  const slotCount = blockSize <= SMALL_BLOCK_BYTES ? SLOTS_SMALL_BLOCK : SLOTS_DEFAULT
  const slots = Array.from({ length: slotCount }, () => new SharedArrayBuffer(SLOT_RESERVE + blockSize))
  const control = new SharedArrayBuffer(4)
  const bundle = Thread.prepare(entry, { shared: true })
  const mount = Thread.mountFor(entry)
  const content = openThread('content', bundle, mount, { slots, control })
  let chunks
  try {
    chunks = openThread('chunks', bundle, mount, { slots, control })
  } catch (err) {
    closeLink(content)
    throw err
  }
  // livePass holds the id of the pass the threads may work on; 0 tells them to skip what is queued.
  // fault is set once either thread is gone, and onFault tells the pass in flight.
  const threads = { content, chunks, views: slots.map((s) => Buffer.from(s)), livePass: new Int32Array(control), passes: 0, fault: null, onFault: null }
  for (const link of [content, chunks]) {
    link.stopped.then((err) => {
      threads.fault ??= err
      threads.onFault?.(err)
    })
  }
  return threads
}

// opts.blockSize is the largest block a pass reads. opts.onUnavailable({ reason, retry }) hears
// each time the threads could not be started or stopped during a pass.
export function createHashThreads({ blockSize, onUnavailable = null, entry = ENTRY }) {
  let threads = null
  let starts = 0
  let closed = false
  let queue = Promise.resolve()

  const report = (err) => {
    try { onUnavailable?.({ reason: err.message, retry: starts < MAX_STARTS }) } catch {}
  }

  function ensureStarted() {
    if (threads && !threads.fault) return threads
    if (threads) {
      report(threads.fault)
      drop(threads)
    }
    if (closed || starts >= MAX_STARTS) return null
    starts++
    try {
      threads = startThreads(entry, blockSize)
    } catch (err) {
      report(err)
      return null
    }
    return threads
  }

  function setReferenced(t, on) {
    for (const link of [t.content, t.chunks]) on ? link.port.ref() : link.port.unref()
  }

  async function drop(t) {
    if (threads === t) threads = null
    Atomics.store(t.livePass, 0, 0)
    await Promise.all([closeLink(t.content), closeLink(t.chunks)])
  }

  async function runPass(pass) {
    const t = ensureStarted()
    if (!t) return null
    setReferenced(t, true)
    try {
      return await pass(t)
    } catch (err) {
      if (!(err instanceof HashThreadsStopped)) throw err
      await drop(t)
      // close() took the threads away: the overlay is going down, and the pass ends with it.
      if (closed) throw cancelled()
      report(err)
      return null
    } finally {
      if (threads === t) setReferenced(t, false)
    }
  }

  return {
    blockSize,
    // Runs pass(threads) with the threads to itself: the content hash is one stream, so passes
    // take turns. Resolves null when the threads are unavailable or stopped during the pass.
    // A pass waiting for its turn rejects as cancelled once signal.aborted is set: the pass ahead
    // can take minutes, and it never reads another pass's signal. Once it has the threads, the
    // cancel is the pass's own to honour.
    run(pass, signal = null) {
      let waiting = true
      const result = queue.then(() => {
        waiting = false
        if (signal?.aborted) throw cancelled()
        return runPass(pass)
      })
      queue = result.catch(() => {})
      if (!signal) return result
      return new Promise((resolve, reject) => {
        const poll = setInterval(() => {
          if (!waiting) return clearInterval(poll)
          if (!signal.aborted) return
          clearInterval(poll)
          reject(cancelled())
        }, TURN_CANCEL_POLL_MS)
        result.then(resolve, reject).finally(() => clearInterval(poll))
      })
    },
    // Ends the threads at once. A pass in flight sees them stop and rejects as cancelled.
    async close() {
      closed = true
      const t = threads
      if (!t) return
      await drop(t)
      t.content.thread.join()
      t.chunks.thread.join()
    },
  }
}
