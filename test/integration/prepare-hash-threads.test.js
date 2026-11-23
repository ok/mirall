// The prepare pass on the hash threads against the pass on the worker thread: the same result for
// every file, and the worker-thread pass whenever the threads cannot carry a file.
import test from 'brittle'
import { tmpStore, tmpDir, fs, path } from './overlay-engine-helpers.js'
import { scaled } from '../helpers/bare-timing.js'
import { FileIndex } from '../../src/shared/transfer/overlay/engine/store/file-index.js'
import { prepareForServe, hostReadBlock } from '../../src/shared/transfer/overlay/engine/transfer/prepare.js'
import { createHashThreads } from '../../src/shared/transfer/overlay/engine/transfer/hash-threads.js'
import { openFdCount } from '../../src/shared/transfer/overlay/engine/transfer/fd-accounting.js'
import { TIERS, selectTier } from '../../src/shared/transfer/overlay/engine/chunker.js'

const BLOCK = hostReadBlock()
const STOPPING_ENTRY = new URL('../fixtures/hash-threads/stops-at-first-block.js', import.meta.url).pathname

function writeFile(dir, name, size, fill = 'random') {
  const data = Buffer.alloc(size)
  if (fill === 'random') {
    let x = (size * 2654435761) | 1
    for (let i = 0; i + 4 <= size; i += 4) {
      x ^= x << 13; x ^= x >>> 17; x ^= x << 5
      data.writeInt32LE(x, i)
    }
  }
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, data)
  return filePath
}

// The threads behind a counter, so a test can assert that a file really went through them.
function counted(hashThreads) {
  const seen = { runs: 0, carried: 0 }
  const run = async (pass, signal) => {
    seen.runs++
    const result = await hashThreads.run(pass, signal)
    if (result) seen.carried++
    return result
  }
  return { seen, threads: { blockSize: hashThreads.blockSize, run } }
}

async function setup(t, threadOpts = {}) {
  const index = new FileIndex(tmpStore('prepare-threads'))
  await index.ready()
  const unavailable = []
  const hashThreads = createHashThreads({ blockSize: BLOCK, onUnavailable: (u) => unavailable.push(u), ...threadOpts })
  t.teardown(() => hashThreads.close())
  const { seen, threads } = counted(hashThreads)
  return { index, dir: tmpDir('prepare-threads'), hashThreads, threads, seen, unavailable }
}

test('threaded prepare equals the worker-thread prepare for every tier around a read block', async (t) => {
  const { index, dir, threads, seen, unavailable } = await setup(t)
  const sizes = [BLOCK, BLOCK + 1, 2 * BLOCK - 1, 2 * BLOCK + 4097, 3 * BLOCK]
  let files = 0
  for (let tier = 0; tier < TIERS.length; tier++) {
    for (const size of sizes) {
      const filePath = writeFile(dir, `t${tier}-${size}`, size)
      const expected = await prepareForServe(index, filePath, { tier })
      const actual = await prepareForServe(index, filePath, { tier, hashThreads: threads })
      t.is(actual.contentHash, expected.contentHash, `tier ${tier}, ${size} bytes: content hash`)
      t.alike(actual.chunks, expected.chunks, `tier ${tier}, ${size} bytes: ${expected.chunks.length} chunks`)
      t.is(actual.chunks.reduce((n, c) => n + c.length, 0), size, 'the chunks cover the file')
      fs.unlinkSync(filePath)
      files++
    }
  }
  t.is(seen.carried, files, 'every file was hashed on the threads')
  t.alike(unavailable, [], 'the threads stayed up')
})

test('threaded prepare equals the worker-thread prepare at the tier the size selects', async (t) => {
  const { index, dir, threads, seen } = await setup(t)
  // 100 MiB is where tier 2 begins; a file of one byte repeated is cut at the largest chunk only.
  const cases = [['random', 100 * 1024 * 1024 + 4097], ['zero', 2 * BLOCK + 12345]]
  for (const [fill, size] of cases) {
    const filePath = writeFile(dir, `${fill}-${size}`, size, fill)
    const expected = await prepareForServe(index, filePath)
    const actual = await prepareForServe(index, filePath, { hashThreads: threads })
    t.is(actual.tier, selectTier(size))
    t.is(actual.contentHash, expected.contentHash, `${fill}, ${size} bytes: content hash`)
    t.alike(actual.chunks, expected.chunks, `${fill}, ${size} bytes: ${expected.chunks.length} chunks`)
    fs.unlinkSync(filePath)
  }
  t.is(seen.carried, cases.length)
})

test('a file smaller than one read block never reaches the threads', async (t) => {
  const { index, dir, threads, seen } = await setup(t)
  const filePath = writeFile(dir, 'small', BLOCK - 1)
  const expected = await prepareForServe(index, filePath)
  const actual = await prepareForServe(index, filePath, { hashThreads: threads })
  t.is(actual.contentHash, expected.contentHash)
  t.is(seen.runs, 0)
})

test('threaded prepare reports progress per chunk, in file order', async (t) => {
  const { index, dir, threads } = await setup(t)
  const size = 3 * BLOCK + 777
  const filePath = writeFile(dir, 'progress', size)
  const steps = []
  const prepared = await prepareForServe(index, filePath, { hashThreads: threads, onProgress: (n) => steps.push(n) })
  t.alike(steps, prepared.chunks.map((c) => c.length), 'one report per chunk, each of that chunk\'s length')
})

test('two files prepared at once on the same threads each get their own result', async (t) => {
  const { index, dir, threads, seen } = await setup(t)
  const a = writeFile(dir, 'a', 2 * BLOCK + 5)
  const b = writeFile(dir, 'b', 3 * BLOCK + 9)
  const [ea, eb] = [await prepareForServe(index, a), await prepareForServe(index, b)]
  const [ra, rb] = await Promise.all([
    prepareForServe(index, a, { hashThreads: threads }),
    prepareForServe(index, b, { hashThreads: threads }),
  ])
  t.is(ra.contentHash, ea.contentHash)
  t.alike(ra.chunks, ea.chunks)
  t.is(rb.contentHash, eb.contentHash)
  t.alike(rb.chunks, eb.chunks)
  t.is(seen.carried, 2)
})

test('cancel ends a threaded prepare with ECANCELLED and leaves the threads usable', async (t) => {
  const { index, dir, threads, seen, unavailable } = await setup(t)
  const big = writeFile(dir, 'cancelled', 6 * BLOCK)
  const fdsBefore = openFdCount()
  const signal = { aborted: false }
  let reported = 0
  const onProgress = (n) => { reported += n; if (reported > BLOCK) signal.aborted = true }
  await t.exception(prepareForServe(index, big, { hashThreads: threads, signal, onProgress }), /publish aborted/)
  t.ok(reported < 3 * BLOCK, `stopped after ${reported} of ${6 * BLOCK} bytes`)
  t.is(openFdCount(), fdsBefore, 'the source is closed')

  const next = writeFile(dir, 'next', 2 * BLOCK + 3)
  const expected = await prepareForServe(index, next)
  const actual = await prepareForServe(index, next, { hashThreads: threads })
  t.is(actual.contentHash, expected.contentHash, 'the next file is hashed correctly')
  t.alike(actual.chunks, expected.chunks)
  t.is(seen.carried, 1, 'and on the threads')
  t.alike(unavailable, [], 'a cancel is not a thread failure')
})

// REGRESSION (FIX-HASH-TURN-CANCEL: passes take turns on the threads, and a cancelled one that was
// still waiting for its turn stayed until the file ahead of it was hashed to its end.)
test('REGRESSION (FIX-HASH-TURN-CANCEL): a prepare cancelled while it waits for the threads ends at once', { timeout: scaled(15000) }, async (t) => {
  const { index, dir, hashThreads, threads, seen } = await setup(t)
  const filePath = writeFile(dir, 'waiting', 2 * BLOCK + 7)
  let finishAhead
  const ahead = hashThreads.run(() => new Promise((resolve) => { finishAhead = () => resolve('ahead') }))
  const signal = { aborted: false }
  const waiting = prepareForServe(index, filePath, { hashThreads: threads, signal })
  signal.aborted = true
  try {
    await waiting
    t.fail('did not reject')
  } catch (err) {
    t.is(err.code, 'ECANCELLED', 'cancelled while the pass ahead still holds the threads')
  }
  finishAhead()
  t.is(await ahead, 'ahead', 'the pass ahead is not disturbed')

  const expected = await prepareForServe(index, filePath)
  const actual = await prepareForServe(index, filePath, { hashThreads: threads })
  t.is(actual.contentHash, expected.contentHash, 'the next file is hashed correctly')
  t.is(seen.carried, 1, 'and on the threads, which the cancelled pass never took')
})

test('the cancel error carries the code the publish path reads', async (t) => {
  const { index, dir, threads } = await setup(t)
  const filePath = writeFile(dir, 'coded', 2 * BLOCK)
  try {
    await prepareForServe(index, filePath, { hashThreads: threads, signal: { aborted: true } })
    t.fail('did not reject')
  } catch (err) {
    t.is(err.code, 'ECANCELLED')
  }
})

test('a thread that stops mid-file: the file is prepared on the worker thread, progress not repeated', async (t) => {
  const { index, dir, threads, seen, unavailable } = await setup(t, { entry: STOPPING_ENTRY })
  const size = 4 * BLOCK + 11
  const filePath = writeFile(dir, 'stopped', size)
  const expected = await prepareForServe(index, filePath)
  let reported = 0
  let empty = 0
  const onProgress = (n) => { reported += n; if (!(n > 0)) empty++ }
  const actual = await prepareForServe(index, filePath, { hashThreads: threads, onProgress })
  t.is(actual.contentHash, expected.contentHash)
  t.alike(actual.chunks, expected.chunks)
  t.is(reported, size, 'progress adds up to the file once')
  t.is(empty, 0, 'no report is empty or negative')
  t.is(seen.runs, 1, 'the threads were tried')
  t.is(seen.carried, 0, 'and did not carry the file')
  t.is(unavailable.length, 1)
  t.ok(unavailable[0].reason.includes('content hash thread stopped'), unavailable[0].reason)
})

test('threads that keep stopping are given up on after three starts', async (t) => {
  const { index, dir, threads, unavailable } = await setup(t, { entry: STOPPING_ENTRY })
  const filePath = writeFile(dir, 'again', 2 * BLOCK)
  const expected = await prepareForServe(index, filePath)
  for (let i = 0; i < 5; i++) {
    const actual = await prepareForServe(index, filePath, { hashThreads: threads })
    t.is(actual.contentHash, expected.contentHash, `attempt ${i + 1} is prepared`)
  }
  t.alike(unavailable.map((u) => u.retry), [true, true, false], 'three starts, the last one final')
})

test('threads that cannot be started: the file is prepared on the worker thread', async (t) => {
  const { index, dir, threads, unavailable } = await setup(t, { entry: path.join(tmpDir('prepare-threads'), 'no-such-entry.js') })
  const filePath = writeFile(dir, 'unstarted', 2 * BLOCK + 1)
  const expected = await prepareForServe(index, filePath)
  const actual = await prepareForServe(index, filePath, { hashThreads: threads })
  t.is(actual.contentHash, expected.contentHash)
  t.alike(actual.chunks, expected.chunks)
  t.is(unavailable.length, 1)
})

test('an error inside a hash thread is reported, not thrown through the process', async (t) => {
  const { index, dir, hashThreads, threads, seen, unavailable } = await setup(t)
  // A block message naming a slot that does not exist makes the real thread entry throw.
  const result = await hashThreads.run(async (live) => {
    Atomics.store(live.livePass, 0, 1)
    await live.content.port.write({ pass: 1, begin: 1 })
    await live.content.port.write({ pass: 1, slot: 999, start: 0, len: 1 })
    throw await live.content.stopped
  })
  t.is(result, null)
  t.is(unavailable.length, 1)
  t.ok(unavailable[0].reason.includes('content hash thread failed'), unavailable[0].reason)

  const filePath = writeFile(dir, 'after', 2 * BLOCK + 1)
  const expected = await prepareForServe(index, filePath)
  const actual = await prepareForServe(index, filePath, { hashThreads: threads })
  t.is(actual.contentHash, expected.contentHash)
  t.is(seen.carried, 1, 'new threads carry the next file')
})

test('closing the threads mid-file ends the prepare as cancelled', async (t) => {
  const { index, dir, hashThreads, threads } = await setup(t)
  const filePath = writeFile(dir, 'closing', 6 * BLOCK)
  let closing = null
  const onProgress = () => { closing ??= hashThreads.close() }
  try {
    await prepareForServe(index, filePath, { hashThreads: threads, onProgress })
    t.fail('did not reject')
  } catch (err) {
    t.is(err.code, 'ECANCELLED')
  }
  await closing
  const after = await prepareForServe(index, filePath, { hashThreads: threads })
  t.ok(after.contentHash, 'a later file is prepared on the worker thread')
})
