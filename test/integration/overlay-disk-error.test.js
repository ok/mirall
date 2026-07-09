import test from 'brittle'
import { tmpStore, tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'
import { TransferManager } from '../../src/shared/transfer/backends/overlay/vendor/transfer.js'
import { freshPeer } from '../helpers/store.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'

// FIX-129: a disk-write failure during an overlay consumer fetch must surface its
// error code instead of being collapsed to a null "no-holder". This covers the two
// vendor links: writeChunk reporting the code (without leaking an fd — since B1 it
// writes through the transfer's persistent fd, closed on teardown), and fetchFile
// rethrowing a coded fetchContent rejection while still treating an uncoded stall
// as null.

async function setupTransfer () {
  const store = tmpStore('disk-error')
  const index = new FileIndex(store)
  await index.ready()
  const transfer = new TransferManager(index, { journalDir: tmpDir('journals') })
  return { index, transfer }
}

test('REGRESSION (FIX-129): writeChunk surfaces a write error code without opening or leaking an fd', async (t) => {
  const { index, transfer } = await setupTransfer()
  const dir = tmpDir('sender')
  const data = Buffer.from('disk-full receiver payload — a couple of chunks worth of bytes')
  const filePath = path.join(dir, 'f.bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, data)
  const prep = await transfer.prepareFile(filePath, '/f.bin')

  const destPath = path.join(tmpDir('recv'), 'f.bin')
  const state = await transfer.startReceive(destPath, { size: data.length, chunks: prep.chunks, contentHash: prep.contentHash })
  const persistentFd = state.fd
  t.ok(persistentFd != null, 'startReceive opened the persistent fd')

  // Inject ENOSPC on the write and track fd traffic: since B1 the chunk write goes
  // through the persistent fd, so writeChunk must open NOTHING, and the persistent
  // fd must be closed by the consumer teardown (pause), not per chunk.
  const origOpen = fs.openSync
  const origWriteSync = fs.writeSync
  const origCloseSync = fs.closeSync
  let opens = 0
  const closed = []
  fs.openSync = (...a) => { opens++; return origOpen(...a) }
  fs.writeSync = () => { const e = new Error('no space left on device'); e.code = 'ENOSPC'; throw e }
  fs.closeSync = (fd) => { closed.push(fd); return origCloseSync(fd) }
  t.teardown(() => { fs.openSync = origOpen; fs.writeSync = origWriteSync; fs.closeSync = origCloseSync })

  const res = transfer.writeChunk(destPath, 0, data.subarray(0, prep.chunks[0].length))
  t.is(res.ok, false, 'write failure reported')
  t.is(res.code, 'ENOSPC', 'the fs error code is surfaced to the scheduler')
  t.is(opens, 0, 'writeChunk opened no fd (persistent fd only)')

  await transfer.pause(destPath)
  t.ok(closed.includes(persistentFd), 'the persistent fd was closed on teardown')

  await index.close()
})

test('REGRESSION (FIX-129): fetchFile rethrows a local I/O error code; an uncoded stall still yields null', async (t) => {
  await freshPeer(t)
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })
  const overlay = getOverlay()
  // Skip readiness/networking and present a peer so fetchFile proceeds to fetchContent.
  // The fake peer carries the shape the protocol's destroy() touches at teardown.
  overlay._ensure = async () => {}
  overlay._protocol._peers = new Map([['p', { pendingTrees: new Map(), channel: { close () {} } }]])

  overlay._protocol.fetchContent = async () => { const e = new Error('no space left'); e.code = 'ENOSPC'; throw e }
  await t.exception(
    overlay.fetchFile('a'.repeat(64), { destPath: path.join(tmpDir('dl'), 'x'), reSeed: false }),
    /no space/,
    'a coded local I/O error is rethrown, not collapsed to null',
  )

  overlay._protocol.fetchContent = async () => { throw new Error('peer went silent mid-stream') } // no code = stall
  const r = await overlay.fetchFile('b'.repeat(64), { destPath: path.join(tmpDir('dl'), 'y'), reSeed: false })
  t.is(r, null, 'an uncoded stall still collapses to null (no-holder semantics preserved)')
})

// A transfer that ended via _fail (stall / disk error) leaves its state — incl. an
// open fd — in TransferManager._active. A retry/resume re-enters startReceive for
// the same path; it must close the prior fd, not orphan it (fd-leak-per-retry).
test('REGRESSION (FIX-129): startReceive closes a prior transfer\'s fd on re-entry', async (t) => {
  const { index, transfer } = await setupTransfer()
  const dir = tmpDir('sender')
  const data = Buffer.from('content for the fd-leak retry coverage path')
  const filePath = path.join(dir, 'g.bin')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, data)
  const prep = await transfer.prepareFile(filePath, '/g.bin')

  const destPath = path.join(tmpDir('recv'), 'g.bin')
  const meta = { size: data.length, chunks: prep.chunks, contentHash: prep.contentHash }
  await transfer.startReceive(destPath, meta)
  const fd1 = transfer._active.get(destPath).fd
  t.ok(fd1 != null, 'first startReceive opened the persistent fd')

  const origCloseSync = fs.closeSync
  const closed = []
  fs.closeSync = (fd) => { closed.push(fd); return origCloseSync(fd) }
  t.teardown(() => { fs.closeSync = origCloseSync })

  await transfer.startReceive(destPath, meta) // retry of the same path (prior state never cleaned)
  t.ok(closed.includes(fd1), 'the prior fd was closed, not orphaned')
  t.not(transfer._active.get(destPath).fd, fd1, 'a fresh fd replaced it')

  await index.close()
})
