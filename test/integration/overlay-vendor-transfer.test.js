// Ported from hyper-overlay upstream test/transfer.test.js (6cac8ee). Body
// verbatim; only import paths retargeted to the vendored subset. See
// src/shared/transfer/backends/overlay/vendor/PROVENANCE.md.
import test from 'brittle'
import { tmpStore, tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'
import { TransferManager, openFdCount } from '../../src/shared/transfer/backends/overlay/vendor/transfer.js'
import { hashChunk, selectTier, chunk as chunkBuffer } from '../../src/shared/transfer/backends/overlay/vendor/chunker.js'
import crypto from 'hypercore-crypto'

async function setup (transferOpts) {
  const store = tmpStore('transfer')
  const index = new FileIndex(store)
  await index.ready()
  const journalDir = tmpDir('journals')
  const transfer = new TransferManager(index, { journalDir, ...transferOpts })
  return { store, index, transfer, journalDir }
}

function wipeJournals (journalDir) {
  for (const f of fs.readdirSync(journalDir)) fs.unlinkSync(path.join(journalDir, f))
}

function writeTestFile (dir, name, data) {
  fs.mkdirSync(dir, { recursive: true })
  const filePath = path.join(dir, name)
  fs.writeFileSync(filePath, data)
  return filePath
}

// ── Sender: prepareFile ───────────────────────────────────────

test('prepareFile — chunks a small file', async (t) => {
  const { index, transfer } = await setup()
  const dir = tmpDir('sender')
  const data = Buffer.from('Hello, this is a test file for transfer.')
  const filePath = writeTestFile(dir, 'hello.txt', data)

  const result = await transfer.prepareFile(filePath, '/hello.txt')

  t.ok(result)
  t.is(result.size, data.length)
  t.is(result.tier, 0, 'small file = tier 0')
  t.is(result.chunks.length, 1, 'small file = 1 chunk')
  t.ok(result.chunks[0].hash)
  t.is(result.chunks[0].offset, 0)
  t.is(result.chunks[0].length, data.length)

  // File index should be updated
  const meta = await index.getFile('/hello.txt')
  t.ok(meta)
  t.is(meta.size, data.length)
  t.ok(meta.contentHash)

  // Small file should NOT have a persisted chunk map
  t.is(await index.hasChunkMap('/hello.txt'), false)

  await index.close()
})

test('prepareFile — large file persists chunk map', async (t) => {
  const { index, transfer } = await setup()
  const dir = tmpDir('sender')
  const data = crypto.randomBytes(2 * 1024 * 1024) // 2MB
  const filePath = writeTestFile(dir, 'large.bin', data)

  const result = await transfer.prepareFile(filePath, '/large.bin')

  t.ok(result)
  t.is(result.size, data.length)
  t.is(result.tier, 1, '2MB = tier 1')
  t.ok(result.chunks.length > 1)

  // Large file SHOULD have a persisted chunk map
  t.is(await index.hasChunkMap('/large.bin'), true)

  const map = await index.getChunkMap('/large.bin')
  t.is(map.length, result.chunks.length)

  await index.close()
})

test('prepareFile — uses cached chunk map on second call', async (t) => {
  const { index, transfer } = await setup()
  const dir = tmpDir('sender')
  const data = crypto.randomBytes(2 * 1024 * 1024)
  const filePath = writeTestFile(dir, 'cached.bin', data)

  const result1 = await transfer.prepareFile(filePath, '/cached.bin')
  const result2 = await transfer.prepareFile(filePath, '/cached.bin')

  t.is(result1.chunks.length, result2.chunks.length)
  t.is(result1.chunks[0].hash, result2.chunks[0].hash)

  await index.close()
})

test('prepareFile — returns null for missing file', async (t) => {
  const { index, transfer } = await setup()

  const result = await transfer.prepareFile('/nonexistent/file.txt', '/file.txt')
  t.is(result, null)

  await index.close()
})

test('REGRESSION (FIX-1: vanish mid-read): prepareFile re-queues (null), does not throw', async (t) => {
  const { index, transfer } = await setup()
  t.teardown(() => index.close())
  const dir = tmpDir('sender')
  const data = crypto.randomBytes(2 * 1024 * 1024) // >1MB → chunk-map branch (the 43GB repro path)
  const filePath = writeTestFile(dir, 'vanish.bin', data)

  // prepareFile stats filePath exactly twice: the pre-read stat (line 78) succeeds, then the
  // post-read mtime guard re-stats the now-moved-out path and trips ENOENT (the open fd kept
  // the streaming read alive to the end; the read uses fs.open/fs.read, not statSync). Count
  // only stats of the target path so the stub fails ONLY that second stat — immune to any
  // unrelated statSync calls regardless of how the runner schedules tests.
  const realStat = fs.statSync
  let targetStats = 0
  fs.statSync = (p, ...rest) => {
    if (p === filePath && ++targetStats >= 2) {
      const e = new Error(`ENOENT: no such file or directory, stat "${p}"`)
      e.code = 'ENOENT'
      throw e
    }
    return realStat(p, ...rest)
  }
  t.teardown(() => { fs.statSync = realStat })

  const result = await transfer.prepareFile(filePath, '/mir-prep' + filePath, { byHashOnly: true })
  t.is(result, null, 'vanished-mid-read source re-queues instead of throwing')
  t.is(targetStats, 2, 'the post-read guard stat (the 2nd stat of the source) was reached')
})

test('prepareFile — returns the content hash and reports streaming progress', async (t) => {
  const { index, transfer } = await setup()
  const data = crypto.randomBytes(256 * 1024)
  const filePath = writeTestFile(tmpDir('sender'), 'h.bin', data)
  let seen = 0
  const prepared = await transfer.prepareFile(filePath, '/h.bin', { onProgress: (n) => { seen += n } })
  t.is(prepared.contentHash, crypto.data(data).toString('hex'), 'content hash == the wire (size-bound) hash')
  t.is(seen, data.length, 'onProgress summed to the whole file')
  // The cached second call still surfaces the content hash (from the file index).
  const again = await transfer.prepareFile(filePath, '/h.bin')
  t.is(again.contentHash, prepared.contentHash, 'cached path returns the content hash too')
  await index.close()
})

test('prepareFile — no data field in chunks', async (t) => {
  const { index, transfer } = await setup()
  const dir = tmpDir('sender')
  const data = crypto.randomBytes(100 * 1024)
  const filePath = writeTestFile(dir, 'nodata.bin', data)

  const result = await transfer.prepareFile(filePath, '/nodata.bin')

  for (const c of result.chunks) {
    t.absent(c.data, 'no data in chunk metadata')
  }

  await index.close()
})

// ── Sender: readChunk ─────────────────────────────────────────

test('readChunk — reads bytes at offset', async (t) => {
  const { index, transfer } = await setup()
  const dir = tmpDir('sender')
  const data = Buffer.from('AAAABBBBCCCCDDDD')
  const filePath = writeTestFile(dir, 'chunks.bin', data)

  const chunk = transfer.readChunk(filePath, 4, 4)
  t.ok(chunk)
  t.alike(chunk, Buffer.from('BBBB'))

  const chunk2 = transfer.readChunk(filePath, 8, 8)
  t.alike(chunk2, Buffer.from('CCCCDDDD'))

  await index.close()
})

test('readChunk — returns null for missing file', async (t) => {
  const { transfer } = await setup()
  t.is(transfer.readChunk('/nonexistent', 0, 10), null)
})

// ── Sender: computeNeeded ─────────────────────────────────────

test('computeNeeded — filters out chunks peer already has', async (t) => {
  const { transfer } = await setup()

  const offered = [
    { hash: 'h1', offset: 0, length: 100 },
    { hash: 'h2', offset: 100, length: 100 },
    { hash: 'h3', offset: 200, length: 100 },
    { hash: 'h4', offset: 300, length: 100 }
  ]

  const peerHas = new Set(['h1', 'h3'])
  const needed = transfer.computeNeeded(offered, peerHas)

  t.alike(needed, [1, 3], 'only indices 1 and 3 needed')
})

test('computeNeeded — peer has nothing → all needed', async (t) => {
  const { transfer } = await setup()

  const offered = [
    { hash: 'h1', offset: 0, length: 100 },
    { hash: 'h2', offset: 100, length: 100 }
  ]

  const needed = transfer.computeNeeded(offered, new Set())
  t.alike(needed, [0, 1])
})

test('computeNeeded — peer has everything → nothing needed', async (t) => {
  const { transfer } = await setup()

  const offered = [
    { hash: 'h1', offset: 0, length: 100 },
    { hash: 'h2', offset: 100, length: 100 }
  ]

  const needed = transfer.computeNeeded(offered, new Set(['h1', 'h2']))
  t.alike(needed, [])
})

// ── Receiver: full transfer flow ──────────────────────────────

test('receive flow — small file round-trip', async (t) => {
  const { index, transfer } = await setup()

  // Sender side: prepare the file
  const senderDir = tmpDir('sender')
  const original = Buffer.from('This is the file content to transfer over P2P.')
  const senderPath = writeTestFile(senderDir, 'doc.txt', original)
  const prepared = await transfer.prepareFile(senderPath, '/doc.txt')

  // Receiver side: start receiving
  const receiverDir = tmpDir('receiver')
  const targetPath = path.join(receiverDir, 'doc.txt')
  const state = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })

  t.ok(state.partialPath.endsWith('.overlay-partial'))
  t.is(state.total, 1)

  // Simulate chunk transfer: sender reads, receiver writes
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    const data = transfer.readChunk(senderPath, c.offset, c.length)
    const result = transfer.writeChunk(targetPath, i, data)
    t.ok(result.ok, `chunk ${i} written`)
  }

  // Check progress
  t.is(transfer.isComplete(targetPath), true)
  const progress = transfer.getProgress(targetPath)
  t.is(progress.percentage, 100)

  // Finalize
  const fin = await transfer.finalize(targetPath)
  t.ok(fin.ok, 'finalized')

  // Verify the file on disk
  const received = fs.readFileSync(targetPath)
  t.alike(received, original, 'file content matches')

  // Partial file should be gone
  t.is(fs.existsSync(state.partialPath), false, 'partial file removed')

  await index.close()
})

test('receive flow — multi-chunk file', async (t) => {
  const { index, transfer } = await setup()

  const senderDir = tmpDir('sender')
  const original = crypto.randomBytes(128 * 1024) // 128KB, multiple chunks
  const senderPath = writeTestFile(senderDir, 'multi.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/multi.bin')

  t.ok(prepared.chunks.length > 1, `${prepared.chunks.length} chunks`)

  const receiverDir = tmpDir('receiver')
  const targetPath = path.join(receiverDir, 'multi.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })

  // Transfer all chunks
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    const data = transfer.readChunk(senderPath, c.offset, c.length)
    const result = transfer.writeChunk(targetPath, i, data)
    t.ok(result.ok)
  }

  t.ok(transfer.isComplete(targetPath))
  await transfer.finalize(targetPath)

  const received = fs.readFileSync(targetPath)
  t.alike(received, original, 'content matches')

  await index.close()
})

test('receive flow — out-of-order chunks', async (t) => {
  const { index, transfer } = await setup()

  const senderDir = tmpDir('sender')
  const original = crypto.randomBytes(128 * 1024)
  const senderPath = writeTestFile(senderDir, 'ooo.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/ooo.bin')

  const receiverDir = tmpDir('receiver')
  const targetPath = path.join(receiverDir, 'ooo.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })

  // Send chunks in reverse order
  for (let i = prepared.chunks.length - 1; i >= 0; i--) {
    const c = prepared.chunks[i]
    const data = transfer.readChunk(senderPath, c.offset, c.length)
    const result = transfer.writeChunk(targetPath, i, data)
    t.ok(result.ok)
  }

  t.ok(transfer.isComplete(targetPath))
  await transfer.finalize(targetPath)

  const received = fs.readFileSync(targetPath)
  t.alike(received, original, 'content matches even with out-of-order chunks')

  await index.close()
})

// REGRESSION (FIX: end-of-download delay): when startReceive is given the
// expected content hash, the WHOLE-file digest is computed incrementally as
// chunks land — finalize verifies it with no trailing re-read of the file.
test('incremental verify — correct content hash finalizes (in-order)', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'iv.bin', original)
  const oid = crypto.data(original).toString('hex')
  const prepared = await transfer.prepareFile(senderPath, '/iv.bin')

  const targetPath = path.join(tmpDir('receiver'), 'iv.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    t.ok(transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length)).ok)
  }
  const fin = await transfer.finalize(targetPath)
  t.ok(fin.ok, 'finalize ok with the correct content hash')
  t.alike(fs.readFileSync(targetPath), original, 'bytes match')

  await index.close()
})

test('incremental verify — correct hash finalizes even with out-of-order arrival', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'ivo.bin', original)
  const oid = crypto.data(original).toString('hex')
  const prepared = await transfer.prepareFile(senderPath, '/ivo.bin')

  const targetPath = path.join(tmpDir('receiver'), 'ivo.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  for (let i = prepared.chunks.length - 1; i >= 0; i--) {
    const c = prepared.chunks[i]
    t.ok(transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length)).ok)
  }
  const fin = await transfer.finalize(targetPath)
  t.ok(fin.ok, 'finalize ok — the hash frontier handles reordering')
  t.alike(fs.readFileSync(targetPath), original, 'bytes match')

  await index.close()
})

test('incremental verify — wrong content hash rejects in finalize, no file lands', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'ivm.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/ivm.bin')

  const targetPath = path.join(tmpDir('receiver'), 'ivm.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: 'f'.repeat(64) })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  const fin = await transfer.finalize(targetPath)
  t.absent(fin.ok, 'finalize rejects on whole-file hash mismatch')
  t.is(fin.code, 'EHASHMISMATCH', 'surfaces EHASHMISMATCH')
  t.absent(fs.existsSync(targetPath), 'no file landed on mismatch')

  await index.close()
})

// ── Resume + pause ────────────────────────────────────────────

function partialFor (targetPath) {
  return path.join(path.dirname(targetPath), path.basename(targetPath) + '.overlay-partial')
}

test('startReceive resumes a partial: verified chunks kept, gaps re-needed', async (t) => {
  const { index, transfer } = await setup()
  const senderPath = writeTestFile(tmpDir('sender'), 'resume.bin', crypto.randomBytes(256 * 1024))
  const prepared = await transfer.prepareFile(senderPath, '/resume.bin')
  t.ok(prepared.chunks.length > 4, `${prepared.chunks.length} chunks`)

  const targetPath = path.join(tmpDir('receiver'), 'resume.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })
  const half = Math.floor(prepared.chunks.length / 2)
  for (let i = 0; i < half; i++) {
    const c = prepared.chunks[i]
    t.ok(transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length)).ok)
  }
  await transfer.pause(targetPath) // keeps the partial on disk
  t.ok(fs.existsSync(partialFor(targetPath)), 'partial kept after pause')

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })
  t.is(st.received.size, half, 'written chunks recognized from the partial on resume')
  for (let i = 0; i < half; i++) t.ok(st.received.has(i), `chunk ${i} present`)
  for (let i = half; i < prepared.chunks.length; i++) t.absent(st.received.has(i), `unwritten chunk ${i} not present`)

  // Finish the resumed transfer from where it left off.
  for (let i = half; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    t.ok(transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length)).ok)
  }
  t.ok((await transfer.finalize(targetPath)).ok, 'resumed transfer finalizes')
  t.alike(fs.readFileSync(targetPath), fs.readFileSync(senderPath), 'resumed file matches the source')

  await index.close()
})

test('B: prepareFile aborts on an aborted signal (ECANCELLED), reader torn down', async (t) => {
  const { index, transfer } = await setup()
  const p = writeTestFile(tmpDir('sender'), 'abrt.bin', crypto.randomBytes(4 * 1024 * 1024))
  await t.exception(transfer.prepareFile(p, '/abrt.bin', { signal: { aborted: true } }), /abort/i, 'a pre-aborted signal stops the hash')
  await index.close()
})

test('a corrupted partial chunk is not trusted on resume (re-needed)', async (t) => {
  const { index, transfer } = await setup()
  const senderPath = writeTestFile(tmpDir('sender'), 'corrupt.bin', crypto.randomBytes(256 * 1024))
  const prepared = await transfer.prepareFile(senderPath, '/corrupt.bin')

  const targetPath = path.join(tmpDir('receiver'), 'corrupt.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)

  const fd = fs.openSync(partialFor(targetPath), 'r+')
  fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, prepared.chunks[2].offset)
  fs.closeSync(fd)

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })
  t.absent(st.received.has(2), 'corrupted chunk fails verification and is re-needed')
  t.ok(st.received.has(0) && st.received.has(1) && st.received.has(3), 'intact chunks still recognized')

  transfer.cancel(targetPath)
  await index.close()
})

test('pause keeps the partial (active transfer cleared); cancel needs an active transfer', async (t) => {
  const { index, transfer } = await setup()
  const targetPath = path.join(tmpDir('receiver'), 'pc.bin')
  const state = await transfer.startReceive(targetPath, { size: 100, chunks: [{ hash: 'h1', offset: 0, length: 100 }] })
  await transfer.pause(targetPath)
  t.ok(fs.existsSync(state.partialPath), 'pause keeps the partial on disk')
  t.is(transfer.getProgress(targetPath), null, 'pause removes the active transfer')
  fs.unlinkSync(state.partialPath) // the loose layer unlinks a paused partial by path on discard
  await index.close()
})

// ── Receiver: hash verification ───────────────────────────────

test('writeChunk — rejects bad hash', async (t) => {
  const { index, transfer } = await setup()

  const receiverDir = tmpDir('receiver')
  const targetPath = path.join(receiverDir, 'bad.bin')

  await transfer.startReceive(targetPath, {
    size: 10,
    chunks: [{ hash: 'a'.repeat(64), offset: 0, length: 10 }]
  })

  const badData = Buffer.from('wrong data')
  const result = transfer.writeChunk(targetPath, 0, badData)
  t.is(result.ok, false)
  t.ok(result.error.includes('hash mismatch'))

  transfer.cancel(targetPath)
  await index.close()
})

// ── Cancel + cleanup ──────────────────────────────────────────

test('cancel removes partial file', async (t) => {
  const { index, transfer } = await setup()

  const receiverDir = tmpDir('receiver')
  const targetPath = path.join(receiverDir, 'cancel.bin')

  const state = await transfer.startReceive(targetPath, {
    size: 100,
    chunks: [{ hash: 'h1', offset: 0, length: 100 }]
  })

  t.ok(fs.existsSync(state.partialPath), 'partial exists')

  transfer.cancel(targetPath)

  t.is(fs.existsSync(state.partialPath), false, 'partial cleaned up')
  t.is(transfer.getProgress(targetPath), null, 'no active transfer')

  await index.close()
})

test('finalize rejects incomplete transfer', async (t) => {
  const { index, transfer } = await setup()

  const receiverDir = tmpDir('receiver')
  const targetPath = path.join(receiverDir, 'incomplete.bin')

  await transfer.startReceive(targetPath, {
    size: 200,
    chunks: [
      { hash: 'h1', offset: 0, length: 100 },
      { hash: 'h2', offset: 100, length: 100 }
    ]
  })

  const result = await transfer.finalize(targetPath)
  t.is(result.ok, false)
  t.ok(result.error.includes('incomplete'))

  transfer.cancel(targetPath)
  await index.close()
})

// ── listActive ────────────────────────────────────────────────

test('listActive shows active transfers', async (t) => {
  const { index, transfer } = await setup()

  t.is(transfer.listActive().length, 0)

  const dir = tmpDir('receiver')
  await transfer.startReceive(path.join(dir, 'a.bin'), { size: 100, chunks: [{ hash: 'h1', offset: 0, length: 100 }] })
  await transfer.startReceive(path.join(dir, 'b.bin'), { size: 200, chunks: [{ hash: 'h2', offset: 0, length: 200 }] })

  const active = transfer.listActive()
  t.is(active.length, 2)

  transfer.cancel(path.join(dir, 'a.bin'))
  transfer.cancel(path.join(dir, 'b.bin'))
  await index.close()
})

// ── cleanPartials ─────────────────────────────────────────────

test('cleanPartials removes old partial files', async (t) => {
  const { transfer } = await setup()
  const dir = tmpDir('partials')

  // Create a fake stale partial
  const partial = path.join(dir, '.stale.txt.overlay-partial')
  fs.writeFileSync(partial, 'stale data')

  // Set mtime to 48 hours ago
  const old = new Date(Date.now() - 48 * 60 * 60 * 1000)
  fs.utimesSync(partial, old, old)

  const cleaned = transfer.cleanPartials(dir, 86400000)
  t.is(cleaned.length, 1)
  t.is(fs.existsSync(partial), false)
})

// ── Phase 1/2: block-read prepareFile stays byte-exact and fd-safe ──

test('prepareFile — content hash and chunk map match the buffer-mode reference', async (t) => {
  const { index, transfer } = await setup()
  const dir = tmpDir('equiv')
  const data = crypto.randomBytes(10 * 1024 * 1024) // > read block → exercises multi-block read
  const filePath = writeTestFile(dir, 'equiv.bin', data)

  const result = await transfer.prepareFile(filePath, '/equiv.bin')
  const tier = selectTier(data.length)
  const ref = chunkBuffer(data, { tier })

  t.is(result.contentHash, hashChunk(data), 'content hash equals one-shot whole-file hash')
  t.is(result.chunks.length, ref.length, 'same chunk count as buffer-mode chunker')
  for (let i = 0; i < ref.length; i++) {
    t.is(result.chunks[i].hash, ref[i].hash, 'chunk ' + i + ' hash')
    t.is(result.chunks[i].offset, ref[i].offset, 'chunk ' + i + ' offset')
    t.is(result.chunks[i].length, ref[i].length, 'chunk ' + i + ' length')
  }

  const byHash = await index.getChunkMapByHash(result.contentHash)
  t.is(byHash.length, ref.length, 'persisted content-addressed map matches')

  await index.close()
})

test('prepareFile — aborting mid-stream rejects and leaks no fd', async (t) => {
  const { index, transfer } = await setup()
  const dir = tmpDir('fdleak')
  const big = writeTestFile(dir, 'big.bin', crypto.randomBytes(10 * 1024 * 1024))

  // aborted runs throw before any persist, isolating the reader's fd lifecycle
  await transfer.prepareFile(big, '/warm', { byHashOnly: true, signal: { aborted: true } }).catch(() => {})
  const ITERS = 25
  const before = fdCount()
  for (let i = 0; i < ITERS; i++) {
    let code = null
    try { await transfer.prepareFile(big, '/abort-' + i, { byHashOnly: true, signal: { aborted: true } }) } catch (e) { code = e.code }
    t.is(code, 'ECANCELLED', 'abort ' + i + ' rejects with ECANCELLED')
  }
  const after = fdCount()
  // A leak in the reader grows 1 fd per abort; the count must come back exactly level.
  t.is(after, before, `no fd leaked across ${ITERS} aborted prepareFile runs (${before} -> ${after})`)

  await index.close()
})

// ── Async/journaled resume (resume-rehash-freeze fix) ─────────

test('REGRESSION (FIX-A): journal-less resume verifies via async I/O, not blocking readSync', async (t) => {
  const { index, transfer, journalDir } = await setup()
  const senderPath = writeTestFile(tmpDir('sender'), 'freeze.bin', crypto.randomBytes(256 * 1024))
  const prepared = await transfer.prepareFile(senderPath, '/freeze.bin')
  t.ok(prepared.chunks.length > 4, `${prepared.chunks.length} chunks`)
  const targetPath = path.join(tmpDir('receiver'), 'freeze.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)
  wipeJournals(journalDir) // model a lost/pre-upgrade journal → force the async re-verify

  // The fix replaced a synchronous fs.readSync verify loop (which froze the worker
  // event loop) with an async, yielding fs.read pass. Proven deterministically by
  // the read primitive used: zero blocking readSync, at least one async read.
  const realRead = fs.read
  const realReadSync = fs.readSync
  let asyncReads = 0
  let syncReads = 0
  fs.read = (...a) => { asyncReads++; return realRead(...a) }
  fs.readSync = (...a) => { syncReads++; return realReadSync(...a) }
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  fs.read = realRead
  fs.readSync = realReadSync
  t.is(syncReads, 0, 'no blocking readSync during the resume')
  t.ok(asyncReads >= prepared.chunks.length, 'each chunk verified via async fs.read')
  transfer.cancel(targetPath)
  await index.close()
})

test('REGRESSION (FIX-A): journal-less resume aborts on isCancelled', async (t) => {
  const { index, transfer, journalDir } = await setup()
  const senderPath = writeTestFile(tmpDir('sender'), 'cancel.bin', crypto.randomBytes(256 * 1024))
  const prepared = await transfer.prepareFile(senderPath, '/cancel.bin')
  const targetPath = path.join(tmpDir('receiver'), 'cancel.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)
  wipeJournals(journalDir)
  let calls = 0
  await t.exception(
    transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash }, { isCancelled: () => (++calls > 1) }),
    /cancel/i, 'a mid-scan cancel rejects with ECANCELLED')
  await index.close()
})

test('REGRESSION (FIX-A): _recoverPartialAsync reports a 0..1 verify fraction', async (t) => {
  const { index, transfer, journalDir } = await setup()
  const senderPath = writeTestFile(tmpDir('sender'), 'frac.bin', crypto.randomBytes(256 * 1024))
  const prepared = await transfer.prepareFile(senderPath, '/frac.bin')
  const targetPath = path.join(tmpDir('receiver'), 'frac.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)
  wipeJournals(journalDir)
  const seen = []
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash }, { onVerifyProgress: (f) => seen.push(f) })
  t.is(seen[0], 0, 'first report is 0')
  t.is(seen[seen.length - 1], 1, 'last report is 1')
  for (let i = 1; i < seen.length; i++) t.ok(seen[i] >= seen[i - 1], 'non-decreasing')
  transfer.cancel(targetPath)
  await index.close()
})

test('FIX-C: journal resume does NOT report a verify fraction (O(1), no scan)', async (t) => {
  const { index, transfer } = await setup()
  const senderPath = writeTestFile(tmpDir('sender'), 'nofrac.bin', crypto.randomBytes(256 * 1024))
  const prepared = await transfer.prepareFile(senderPath, '/nofrac.bin')
  const targetPath = path.join(tmpDir('receiver'), 'nofrac.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  for (let i = 0; i < Math.floor(prepared.chunks.length / 2); i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)
  const seen = []
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash }, { onVerifyProgress: (f) => seen.push(f) })
  t.is(seen.length, 0, 'journal resume skipped the verify scan')
  transfer.cancel(targetPath)
  await index.close()
})

test('REGRESSION (FIX-B): snapshot resume is O(1) and finalizes verified, no re-read', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'snap.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/snap.bin')
  const oid = prepared.contentHash
  const targetPath = path.join(tmpDir('receiver'), 'snap.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  const half = Math.floor(prepared.chunks.length / 2)
  for (let i = 0; i < half; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)

  const realRead = fs.read
  const realReadSync = fs.readSync
  let reads = 0
  fs.read = (...a) => { reads++; return realRead(...a) }
  fs.readSync = (...a) => { reads++; return realReadSync(...a) }
  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  fs.read = realRead
  fs.readSync = realReadSync
  t.is(reads, 0, 'snapshot resume read zero chunks (O(1))')
  t.is(st.received.size, half, 'received-set restored from the journal')

  for (let i = half; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    t.ok(transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length)).ok)
  }
  const fin = await transfer.finalize(targetPath)
  t.ok(fin.ok, 'resumed transfer finalizes verified via the restored snapshot')
  t.alike(fs.readFileSync(targetPath), original, 'bytes match')
  await index.close()
})

test('REGRESSION (FIX-B): a fresh TransferManager resumes from the on-disk journal', async (t) => {
  const { index, transfer, journalDir } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'restart.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/restart.bin')
  const oid = prepared.contentHash
  const targetPath = path.join(tmpDir('receiver'), 'restart.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  const half = Math.floor(prepared.chunks.length / 2)
  for (let i = 0; i < half; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)

  const fresh = new TransferManager(index, { journalDir })
  const st = await fresh.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  t.is(st.received.size, half, 'received-set restored on a brand-new manager')
  for (let i = half; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    t.ok(fresh.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length)).ok)
  }
  t.ok((await fresh.finalize(targetPath)).ok, 'finalizes verified after a simulated restart')
  t.alike(fs.readFileSync(targetPath), original, 'bytes match')
  await index.close()
})

test('REGRESSION (FIX-WIN: fsync on a read-only handle throws on Windows): journal still persists, resume stays O(1)', async (t) => {
  const { index, transfer, journalDir } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'winfsync.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/winfsync.bin')
  const oid = prepared.contentHash
  const targetPath = path.join(tmpDir('receiver'), 'winfsync.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  const half = Math.floor(prepared.chunks.length / 2)
  for (let i = 0; i < half; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }

  // Windows FlushFileBuffers needs GENERIC_WRITE; fsync on a read-only handle fails EPERM.
  const realFsync = fs.fsync
  const realFsyncSync = fs.fsyncSync
  fs.fsyncSync = () => { const e = new Error('EPERM: operation not permitted, fsync'); e.code = 'EPERM'; throw e }
  fs.fsync = () => Promise.reject(Object.assign(new Error('EPERM: operation not permitted, fsync'), { code: 'EPERM' }))
  t.teardown(() => { fs.fsync = realFsync; fs.fsyncSync = realFsyncSync })

  await transfer.pause(targetPath)
  t.ok(fs.readdirSync(journalDir).some((f) => f.endsWith('.journal')), 'journal persisted despite fsync throwing')

  fs.fsync = realFsync
  fs.fsyncSync = realFsyncSync

  const seen = []
  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid }, { onVerifyProgress: (f) => seen.push(f) })
  t.is(seen.length, 0, 'resume loaded the journal O(1) — no re-verify scan')
  t.is(st.received.size, half, 'received-set restored from the persisted journal')

  for (let i = half; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    t.ok(transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length)).ok)
  }
  t.ok((await transfer.finalize(targetPath)).ok, 'resumed transfer finalizes verified')
  t.alike(fs.readFileSync(targetPath), original, 'bytes match')
  await index.close()
})

test('FIX-B: snapshot resume + out-of-order remainder finalizes', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'ooo2.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/ooo2.bin')
  const oid = prepared.contentHash
  const targetPath = path.join(tmpDir('receiver'), 'ooo2.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  const half = Math.floor(prepared.chunks.length / 2)
  for (let i = 0; i < half; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  for (let i = prepared.chunks.length - 1; i >= half; i--) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  t.ok((await transfer.finalize(targetPath)).ok, 'snapshot frontier handles reordering')
  t.alike(fs.readFileSync(targetPath), original, 'bytes match')
  await index.close()
})

test('REGRESSION (FIX-B): journal trusts the bitmap; manual reverify catches on-disk rot', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'p2.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/p2.bin')
  const oid = prepared.contentHash
  const targetPath = path.join(tmpDir('receiver'), 'p2.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)
  const fd = fs.openSync(partialFor(targetPath), 'r+')
  fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, prepared.chunks[2].offset)
  fs.closeSync(fd)

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  t.ok(st.received.has(2), 'journaled prefix chunk trusted on resume (no re-read)')
  t.ok((await transfer.finalize(targetPath)).ok, 'automatic stamp does not re-read → accepts the resumed file')
  const actual = await transfer._hashWholeFileAsync(targetPath, prepared.size)
  t.not(actual, oid, 'manual re-verify detects the on-disk corruption')
  await index.close()
})

test('REGRESSION (FIX-B): a non-binding journal is ignored (falls back to re-verify)', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'bind.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/bind.bin')
  const targetPath = path.join(tmpDir('receiver'), 'bind.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  await transfer.pause(targetPath)
  const fd = fs.openSync(partialFor(targetPath), 'r+')
  fs.writeSync(fd, Buffer.alloc(64, 0xff), 0, 64, prepared.chunks[2].offset)
  fs.closeSync(fd)
  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: 'a'.repeat(64) })
  t.absent(st.received.has(2), 'mismatched-content journal ignored → re-verify re-needs the corrupted chunk')
  t.ok(st.received.has(0) && st.received.has(1), 'intact chunks still recognized')
  transfer.cancel(targetPath)
  await index.close()
})

test('REGRESSION (FIX-B): journal removed on finalize; cleanJournals drops orphans', async (t) => {
  const { index, transfer, journalDir } = await setup()
  const original = crypto.randomBytes(128 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'jf.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/jf.bin')
  const targetPath = path.join(tmpDir('receiver'), 'jf.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  for (let i = 0; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
  }
  t.ok((await transfer.finalize(targetPath)).ok)
  t.is(fs.readdirSync(journalDir).length, 0, 'journal gone after finalize')

  const t2 = path.join(tmpDir('receiver'), 'orphan.bin')
  await transfer.startReceive(t2, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  transfer.writeChunk(t2, 0, transfer.readChunk(senderPath, prepared.chunks[0].offset, prepared.chunks[0].length))
  await transfer.pause(t2)
  t.is(fs.readdirSync(journalDir).length, 1, 'journal written on pause')
  fs.unlinkSync(partialFor(t2))
  t.is(transfer.cleanJournals(86400000).length, 1, 'cleanJournals removed the orphan')
  t.is(fs.readdirSync(journalDir).length, 0, 'journal dir empty after sweep')
  await index.close()
})

// REGRESSION (FIX-A2: gap-fill freeze): a low resume frontier with a large received
// tail used to re-hash the whole contiguous run SYNCHRONOUSLY (fs.readSync) inside
// the gap-filling writeChunk — re-introducing the worker freeze. The hash advance is
// now a background async pump, so the gap-fill writeChunk does zero synchronous
// readback; finalize drains the pump and still verifies.
test('REGRESSION (FIX-A2): a gap-fill that unlocks a large run does not block writeChunk', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'gap.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/gap.bin')
  t.ok(prepared.chunks.length > 4, `${prepared.chunks.length} chunks`)
  const oid = prepared.contentHash
  const targetPath = path.join(tmpDir('receiver'), 'gap.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  // Receive every chunk EXCEPT chunk 0 → frontier stuck at 0 with a large received tail.
  for (let i = 1; i < prepared.chunks.length; i++) {
    const c = prepared.chunks[i]
    t.ok(transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length)).ok)
  }
  const c0 = prepared.chunks[0]
  const data0 = transfer.readChunk(senderPath, c0.offset, c0.length)
  const realReadSync = fs.readSync
  let syncReads = 0
  fs.readSync = (...a) => { syncReads++; return realReadSync(...a) }
  t.ok(transfer.writeChunk(targetPath, 0, data0).ok)
  fs.readSync = realReadSync
  t.is(syncReads, 0, 'gap-fill writeChunk did no synchronous readback (hash advance is async)')

  const fin = await transfer.finalize(targetPath)
  t.ok(fin.ok, 'finalizes verified after the async hash drain')
  t.alike(fs.readFileSync(targetPath), original, 'bytes match')
  await index.close()
})

// ── B1/B2: persistent fd + in-memory in-order hashing ─────────

// The fd oracle is the TransferManager's own accounting, NOT the process fd table.
// `brittle-bare -j` runs test files as threads in one process, so /dev/fd and
// /proc/self/fd are shared with three sibling files and churn by hundreds mid-test —
// a delta taken from them is noise, and once even came out negative. openFdCount()
// sees only the descriptors this module opened, so these assertions can be exact.
const fdCount = () => openFdCount()

function deliver (transfer, senderPath, prepared, targetPath, i) {
  const c = prepared.chunks[i]
  return transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
}

test('B1: fd count stays flat across a multi-chunk transfer and 20 transfers', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(1024 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'b1.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/b1.bin')
  t.ok(prepared.chunks.length > 4, `${prepared.chunks.length} chunks`)
  const oid = prepared.contentHash

  const targetPath = path.join(tmpDir('rx'), 'b1.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  const afterStart = fdCount()
  t.is(afterStart, 1, 'startReceive holds exactly ONE persistent fd')
  for (let i = 0; i < prepared.chunks.length; i++) t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok)
  const beforeFin = fdCount()
  // The B1 invariant: one handle serves every chunk write. The pre-B1 code opened and
  // closed per chunk, so a regression shows up as movement here.
  t.is(beforeFin, afterStart, `fd flat during transfer (${afterStart} -> ${beforeFin})`)
  t.ok((await transfer.finalize(targetPath)).ok, 'finalize ok — fd closed before rename')
  t.alike(fs.readFileSync(targetPath), original, 'round-trip byte-exact')

  const before = fdCount()
  for (let k = 0; k < 20; k++) {
    const p = path.join(tmpDir('rx-b1-' + k), 'b1.bin')
    await transfer.startReceive(p, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
    for (let i = 0; i < prepared.chunks.length; i++) deliver(transfer, senderPath, prepared, p, i)
    t.ok((await transfer.finalize(p)).ok)
  }
  const after = fdCount()
  t.is(before, 0, 'finalize closed the fd — none held between transfers')
  t.is(after, before, `no fd leak across 20 transfers (${before} -> ${after})`)
  await index.close()
})

test('B1: pause closes the fd; a late chunk is refused codeless; resume completes', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(512 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'b1p.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/b1p.bin')
  const oid = prepared.contentHash
  const targetPath = path.join(tmpDir('rx'), 'b1p.bin')

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  const half = Math.floor(prepared.chunks.length / 2)
  for (let i = 0; i < half; i++) t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok)
  await transfer.pause(targetPath)
  t.is(st.fd, null, 'pause released the persistent fd')
  t.is(st.memBytes, 0, 'pause dropped the stash')

  const late = deliver(transfer, senderPath, prepared, targetPath, half)
  t.absent(late.ok, 'chunk after pause refused')
  t.absent(late.code, 'refusal carries no code (scheduler re-assigns, not _fail)')

  const st2 = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  t.is(st2.received.size, half, 'resume recovered the written chunks')
  for (let i = half; i < prepared.chunks.length; i++) t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok)
  t.ok((await transfer.finalize(targetPath)).ok, 'digest verifies across pause/resume on the unified fd')
  t.alike(fs.readFileSync(targetPath), original)
  await index.close()
})

test('B2: in-order delivery hashes from memory — zero read-backs', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(512 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'b2i.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/b2i.bin')
  const targetPath = path.join(tmpDir('rx'), 'b2i.bin')

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  // tight synchronous loop on purpose — protomux delivers frame bursts with no
  // microtask boundary between chunks, and the stash must still engage
  for (let i = 0; i < prepared.chunks.length; i++) t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok)
  t.is(st.memBytes, 0, 'stash fully drained before finalize')
  t.ok((await transfer.finalize(targetPath)).ok, 'memory-fed digest verifies')
  t.is(st.stats.readbacks, 0, 'no disk read-back on the in-order path')
  t.is(st.stats.stashHits, prepared.chunks.length, 'every chunk consumed from the stash')
  t.alike(fs.readFileSync(targetPath), original)
  await index.close()
})

test('B2: reverse-order delivery verifies; gap chunks under the cap come from the stash', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(512 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'b2r.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/b2r.bin')
  t.ok(prepared.chunks.length >= 4)
  const targetPath = path.join(tmpDir('rx'), 'b2r.bin')

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  for (let i = prepared.chunks.length - 1; i >= 0; i--) t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok, `chunk ${i}`)
  t.is(st.memBytes, 0, 'stash fully drained before finalize')
  t.ok((await transfer.finalize(targetPath)).ok, 'out-of-order digest identical')
  t.is(st.stats.readbacks, 0, 'all gap chunks fit the default cap — served from the stash')
  t.alike(fs.readFileSync(targetPath), original)
  await index.close()
})

test('B2: zero cap forces the read-back fallback — digest still verifies', async (t) => {
  const { index, transfer } = await setup({ memStashBytes: 0 })

  const original = crypto.randomBytes(512 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'b2c.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/b2c.bin')
  const targetPath = path.join(tmpDir('rx'), 'b2c.bin')

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  for (let i = prepared.chunks.length - 1; i >= 0; i--) t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok)
  t.ok((await transfer.finalize(targetPath)).ok, 'read-back path produces the identical digest')
  t.is(st.stats.stashHits, 0, 'nothing stashed at cap 0')
  t.is(st.stats.readbacks, prepared.chunks.length, 'every chunk read back')
  t.alike(fs.readFileSync(targetPath), original)
  await index.close()
})

test('B2: duplicate delivery is idempotent — digest and stash accounting intact', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'b2d.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/b2d.bin')
  const targetPath = path.join(tmpDir('rx'), 'b2d.bin')

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  // park a far gap chunk and deliver it TWICE — accounting must count it once
  const last = prepared.chunks.length - 1
  t.ok(deliver(transfer, senderPath, prepared, targetPath, last).ok)
  deliver(transfer, senderPath, prepared, targetPath, last)
  t.is(st.memBytes, prepared.chunks[last].length, 'duplicate gap delivery counted once')
  for (let i = 0; i < prepared.chunks.length; i++) {
    t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok)
    deliver(transfer, senderPath, prepared, targetPath, i)
  }
  t.is(st.memBytes, 0, 'stash accounting drained to zero before finalize')
  t.ok((await transfer.finalize(targetPath)).ok, 'duplicates do not corrupt the digest')
  t.alike(fs.readFileSync(targetPath), original)
  await index.close()
})

test('B1/B2: cancel clears the fd and the stash', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'b1c.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/b1c.bin')
  const targetPath = path.join(tmpDir('rx'), 'b1c.bin')

  const st = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })
  // deliver a far gap chunk so an entry is parked in the stash
  t.ok(deliver(transfer, senderPath, prepared, targetPath, prepared.chunks.length - 1).ok)
  t.ok(st.memBytes > 0, 'gap chunk parked in the stash')
  transfer.cancel(targetPath)
  t.is(st.fd, null, 'cancel closed the fd')
  t.is(st.memBytes, 0, 'cancel cleared the stash')
  t.is(st.memChunks.size, 0, 'stash map empty')
  t.absent(fs.existsSync(partialFor(targetPath)), 'partial unlinked')
  await index.close()
})

// ── Review fixes: short writes, rename failure ────────────────

test('a short writeSync is retried to completion — no silent hole', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'sw.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/sw.bin')
  const targetPath = path.join(tmpDir('rx'), 'sw.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })

  // model libuv's error-after-partial-progress: return a short count, no throw
  const origWrite = fs.writeSync
  let shorted = 0
  fs.writeSync = (fd, data, off, len, pos) => {
    if (len > 32 && shorted < 3) { shorted++; return origWrite(fd, data, off, len >> 1, pos) }
    return origWrite(fd, data, off, len, pos)
  }
  t.teardown(() => { fs.writeSync = origWrite })
  for (let i = 0; i < prepared.chunks.length; i++) t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok)
  fs.writeSync = origWrite
  t.ok(shorted > 0, 'short writes were injected')
  t.ok((await transfer.finalize(targetPath)).ok, 'digest verifies')
  t.alike(fs.readFileSync(targetPath), original, 'no hole despite short writes')
  await index.close()
})

test('a stuck write (0 bytes forever) fails the chunk with a code', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(64 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'sw0.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/sw0.bin')
  const targetPath = path.join(tmpDir('rx'), 'sw0.bin')
  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash })

  const origWrite = fs.writeSync
  fs.writeSync = () => 0
  t.teardown(() => { fs.writeSync = origWrite })
  const res = deliver(transfer, senderPath, prepared, targetPath, 0)
  fs.writeSync = origWrite
  t.absent(res.ok, 'stuck write fails the chunk')
  t.is(res.code, 'EIO', 'carries a code so the scheduler treats it as fatal, not a mismatch')
  await index.close()
})

test('finalize rename failure carries the code, clears the state, and a retry resumes', async (t) => {
  const { index, transfer } = await setup()
  const original = crypto.randomBytes(256 * 1024)
  const senderPath = writeTestFile(tmpDir('sender'), 'rn.bin', original)
  const prepared = await transfer.prepareFile(senderPath, '/rn.bin')
  const oid = prepared.contentHash
  const targetPath = path.join(tmpDir('rx'), 'rn.bin')

  await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  for (let i = 0; i < prepared.chunks.length; i++) t.ok(deliver(transfer, senderPath, prepared, targetPath, i).ok)

  const origRename = fs.renameSync
  fs.renameSync = () => { const e = new Error('no such file or directory'); e.code = 'ENOENT'; throw e }
  t.teardown(() => { fs.renameSync = origRename })
  const fin = await transfer.finalize(targetPath)
  fs.renameSync = origRename
  t.absent(fin.ok, 'finalize reports the rename failure')
  t.is(fin.code, 'ENOENT', 'the fs error code is surfaced (coded local-I/O classification)')
  t.is(transfer.getProgress(targetPath), null, 'no parked state left in _active')
  t.ok(fs.existsSync(partialFor(targetPath)), 'partial kept for the retry')

  const st2 = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks, contentHash: oid })
  t.is(st2.received.size, prepared.chunks.length, 'retry resumes with all chunks recognized')
  t.ok((await transfer.finalize(targetPath)).ok, 'retry finalizes')
  t.alike(fs.readFileSync(targetPath), original)
  await index.close()
})
