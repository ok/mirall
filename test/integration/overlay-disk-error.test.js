import test from 'brittle'
import crypto from 'hypercore-crypto'
import { tmpStore, tmpDir, fs, path } from './overlay-engine-helpers.js'
import { overlay as linkedOverlay, link } from './overlay-link-helpers.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/engine/store/file-index.js'
import { TransferManager } from '../../src/shared/transfer/backends/overlay/engine/transfer/transfer-manager.js'
import { addPeer } from '../helpers/overlay-engine.js'
import { scaled } from '../helpers/bare-timing.js'

// FIX-129: a disk-write failure during an overlay consumer fetch must surface its
// error code instead of being collapsed to a null "no-holder". This covers the two
// vendor links: writeChunk reporting the code (without leaking an fd — since B1 it
// writes through the transfer's persistent fd, closed on teardown), and fetchFile
// rethrowing a coded fetchContent rejection while still treating an uncoded stall
// as null.

async function setupTransfer() {
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
  const prep = await transfer.prepareFile(filePath)

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

// A facade with one attached peer and no holder gate, so fetchFile proceeds to fetchContent.
async function facadeWith(t) {
  const overlay = await linkedOverlay(t, 'disk-facade')
  addPeer(overlay.protocol, 'p')
  return overlay
}

const failWith = (overlay, code) => {
  overlay.protocol.fetchContent = async () => { const e = new Error('local fault ' + code); e.code = code; throw e }
}

// What the facade answers for each code the scheduler can fail a fetch on.
const SURFACED = ['EHASHMISMATCH', 'ECANCELLED', 'ENOSPC', 'EACCES', 'EROFS', 'EPERM', 'ENOENT',
  'ENOTDIR', 'EISDIR', 'EIO', 'EFBIG', 'ENAMETOOLONG', 'EEXIST', 'EXDEV']
const RETRIED = ['EBUSY', 'EAGAIN', 'EINTR', 'EMFILE', 'ENFILE', 'ETARGETCHANGED']

test('REGRESSION (FIX-129): fetchFile rethrows a local I/O error code; an uncoded stall still yields null', async (t) => {
  const overlay = await facadeWith(t)

  failWith(overlay, 'ENOSPC')
  await t.exception(
    overlay.fetchFile('a'.repeat(64), { destPath: path.join(tmpDir('dl'), 'x') }),
    /local fault ENOSPC/,
    'a coded local I/O error is rethrown, not collapsed to null',
  )

  overlay.protocol.fetchContent = async () => { throw new Error('peer went silent mid-stream') } // no code = stall
  const r = await overlay.fetchFile('b'.repeat(64), { destPath: path.join(tmpDir('dl'), 'y') })
  t.is(r, null, 'an uncoded stall still collapses to null (no-holder semantics preserved)')
})

test('REGRESSION (local faults read as no holder): every non-transient coded fault reaches the caller', async (t) => {
  const overlay = await facadeWith(t)
  for (const code of SURFACED) {
    failWith(overlay, code)
    await t.exception(overlay.fetchFile('c'.repeat(64), { destPath: path.join(tmpDir('dl'), code) }), new RegExp(code), `${code} is rethrown`)
  }
})

test('fault contract: transient write codes and a target collision read as "no holder"', async (t) => {
  const overlay = await facadeWith(t)
  for (const code of RETRIED) {
    failWith(overlay, code)
    t.is(await overlay.fetchFile('d'.repeat(64), { destPath: path.join(tmpDir('dl'), code) }), null, code)
  }
})

test('REGRESSION (local faults read as no holder): a destination under a regular file fails the fetch with its errno', { skip: Bare.platform === 'win32' }, async (t) => {
  const pub = await linkedOverlay(t, 'enotdir-pub')
  const con = await linkedOverlay(t, 'enotdir-con')
  const content = crypto.randomBytes(64 * 1024)
  const oid = crypto.data(content).toString('hex')
  const src = path.join(tmpDir('enotdir-src'), 'doc.bin')
  fs.writeFileSync(src, content)
  await pub.registerFile(src, { contentHash: oid, size: content.length })
  link(pub, con)
  await new Promise((r) => setTimeout(r, scaled(400)))

  const blocker = path.join(tmpDir('enotdir-dl'), 'not-a-folder')
  fs.writeFileSync(blocker, 'a file where the folder belongs')
  const err = await con.fetchFile(oid, { destPath: path.join(blocker, 'child.bin'), timeout: scaled(6000) }).then(() => null, (e) => e)
  t.ok(err, 'the fetch rejected rather than resolving "no holder"')
  // The receive setup's recursive mkdir reports ENOTDIR on some platforms and EEXIST on others.
  t.ok(['ENOTDIR', 'EEXIST'].includes(err?.code), `the setup errno reached the caller (${err?.code})`)
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
  const prep = await transfer.prepareFile(filePath)

  const destPath = path.join(tmpDir('recv'), 'g.bin')
  const meta = { size: data.length, chunks: prep.chunks, contentHash: prep.contentHash }
  await transfer.startReceive(destPath, meta)
  const fd1 = transfer.receiveState(destPath).fd
  t.ok(fd1 != null, 'first startReceive opened the persistent fd')

  const origCloseSync = fs.closeSync
  const closed = []
  fs.closeSync = (fd) => { closed.push(fd); return origCloseSync(fd) }
  t.teardown(() => { fs.closeSync = origCloseSync })

  await transfer.startReceive(destPath, meta) // retry of the same path (prior state never cleaned)
  t.ok(closed.includes(fd1), 'the prior fd was closed, not orphaned')
  t.not(transfer.receiveState(destPath).fd, fd1, 'a fresh fd replaced it')

  await index.close()
})
