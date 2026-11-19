// A hash thread of the prepare pass (hash-threads.js starts two). It reads its role and the shared
// block slots from the thread data and answers on its channel, in the order it was written to:
//
//   content: { pass, begin: size }               opens the file's content hash
//            { pass, slot, start, len }       -> { pass, slot }
//            { pass, end }                    -> { pass, digest, bytes }
//   chunks:  { pass, seq, slot, start, lens } -> { pass, seq, slot, hashes }
//            { pass, flush }                  -> { pass, flushed }
//
// A message whose pass is not the live one is acknowledged without hashing, so a cancelled file
// stops costing anything at the next message. An error is reported as { error } before the thread
// ends: an uncaught one would end the whole process.

import Thread from 'bare-thread'
import Channel from 'bare-channel'
import { hashChunk, createStreamingHasher } from '../chunker.js'

// Shown by the system's thread listings and in crash reports; Linux keeps 15 characters.
const THREAD_NAMES = { content: 'mirall-content', chunks: 'mirall-chunks' }

async function serveContent(port, views, isLive) {
  let hasher = null
  for await (const msg of port) {
    if (msg.begin !== undefined) {
      hasher = createStreamingHasher({ size: msg.begin })
    } else if (msg.end) {
      await port.write({ pass: msg.pass, digest: isLive(msg.pass) ? hasher.digest() : null, bytes: hasher.bytes })
    } else {
      if (isLive(msg.pass)) hasher.update(views[msg.slot].subarray(msg.start, msg.start + msg.len))
      await port.write({ pass: msg.pass, slot: msg.slot })
    }
  }
}

async function serveChunks(port, views, isLive) {
  for await (const msg of port) {
    if (msg.flush) {
      await port.write({ pass: msg.pass, flushed: true })
      continue
    }
    const view = views[msg.slot]
    const hashes = []
    let at = msg.start
    for (const len of msg.lens) {
      if (!isLive(msg.pass)) break
      hashes.push(hashChunk(view.subarray(at, at + len)))
      at += len
    }
    await port.write({ pass: msg.pass, seq: msg.seq, slot: msg.slot, hashes })
  }
}

async function serve({ handle, role, slots, control }) {
  Thread.name = THREAD_NAMES[role]
  const port = Channel.from(handle).connect()
  const views = slots.map((s) => Buffer.from(s))
  const livePass = new Int32Array(control)
  const isLive = (pass) => Atomics.load(livePass, 0) === pass
  try {
    await (role === 'content' ? serveContent(port, views, isLive) : serveChunks(port, views, isLive))
  } catch (err) {
    try { await port.write({ error: err?.message || String(err) }) } catch {}
  }
  await port.close()
}

// Imported anywhere but as a hash thread's entry, this module does nothing.
const started = Thread.self?.data
if (started?.handle && started.role in THREAD_NAMES) await serve(started)
