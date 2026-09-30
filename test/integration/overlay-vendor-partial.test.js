import test from 'brittle'
import { tmpStore, tmpDir, fs, path } from './overlay-vendor-helpers.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'
import { TransferManager } from '../../src/shared/transfer/backends/overlay/vendor/transfer.js'
import crypto from 'hypercore-crypto'

// The receive side writes into folders the user also writes into: the partial beside the target
// must never be followed through a link, and the final rename must never replace a file that
// appeared at the target while the bytes were arriving.

async function receiver(t) {
  const index = new FileIndex(tmpStore('partial'))
  await index.ready()
  t.teardown(() => index.close())
  const transfer = new TransferManager(index, { journalDir: tmpDir('journals') })
  const original = crypto.randomBytes(128 * 1024)
  const senderPath = path.join(tmpDir('sender'), 'f.bin')
  fs.writeFileSync(senderPath, original)
  const prepared = await transfer.prepareFile(senderPath, '/f.bin')
  const targetPath = path.join(tmpDir('rx'), 'f.bin')
  const meta = { size: prepared.size, chunks: prepared.chunks, contentHash: prepared.contentHash }
  const deliverAll = () => {
    for (let i = 0; i < prepared.chunks.length; i++) {
      const c = prepared.chunks[i]
      transfer.writeChunk(targetPath, i, transfer.readChunk(senderPath, c.offset, c.length))
    }
  }
  return { transfer, original, targetPath, partialPath: targetPath + '.overlay-partial', meta, deliverAll }
}

test('REGRESSION (MIR-13): a symlink at the partial is never written through', { skip: Bare.platform === 'win32' }, async (t) => {
  const rx = await receiver(t)
  const outside = path.join(tmpDir('outside'), 'victim.bin')
  fs.writeFileSync(outside, 'precious')
  fs.symlinkSync(outside, rx.partialPath)

  await rx.transfer.startReceive(rx.targetPath, rx.meta)
  rx.deliverAll()
  const fin = await rx.transfer.finalize(rx.targetPath)

  t.ok(fin.ok, 'the receive completes')
  t.is(fs.readFileSync(outside, 'utf8'), 'precious', 'the link target is untouched')
  t.alike(fs.readFileSync(rx.targetPath), rx.original, 'the target holds the received bytes')
})

test('REGRESSION (MIR-13): a same-size symlinked partial is not resumed through', { skip: Bare.platform === 'win32' }, async (t) => {
  const rx = await receiver(t)
  const outside = path.join(tmpDir('outside'), 'victim.bin')
  const precious = Buffer.alloc(rx.meta.size, 7)
  fs.writeFileSync(outside, precious)
  fs.symlinkSync(outside, rx.partialPath)

  const state = await rx.transfer.startReceive(rx.targetPath, rx.meta)
  t.is(state.received.size, 0, 'a link is not a partial to resume')
  rx.deliverAll()
  t.ok((await rx.transfer.finalize(rx.targetPath)).ok, 'the receive completes')
  t.alike(fs.readFileSync(outside), precious, 'the link target is untouched')
})

test('REGRESSION (MIR-13): a target created during the receive is not replaced', async (t) => {
  const rx = await receiver(t)
  await rx.transfer.startReceive(rx.targetPath, rx.meta)
  rx.deliverAll()
  fs.writeFileSync(rx.targetPath, 'the user saved this meanwhile')

  const fin = await rx.transfer.finalize(rx.targetPath)

  t.absent(fin.ok, 'finalize refuses')
  t.is(fin.code, 'ETARGETCHANGED')
  t.is(fs.readFileSync(rx.targetPath, 'utf8'), 'the user saved this meanwhile', 'the new file survives')
  t.absent(fs.existsSync(rx.partialPath), 'the name is no longer this transfer\'s, so its partial goes')
  t.is(rx.transfer.getProgress(rx.targetPath), null, 'and no state is parked')
})

test('a target that was already there and did not change is replaced as before', async (t) => {
  const rx = await receiver(t)
  fs.writeFileSync(rx.targetPath, 'an older copy the caller chose to overwrite')
  await rx.transfer.startReceive(rx.targetPath, rx.meta)
  rx.deliverAll()

  t.ok((await rx.transfer.finalize(rx.targetPath)).ok, 'finalize lands')
  t.alike(fs.readFileSync(rx.targetPath), rx.original)
})

test('a stale partial of the wrong size is replaced by a fresh one', async (t) => {
  const rx = await receiver(t)
  fs.writeFileSync(rx.partialPath, 'a stale partial of the wrong size')
  const state = await rx.transfer.startReceive(rx.targetPath, rx.meta)
  t.is(state.received.size, 0, 'nothing is resumed from it')
  t.is(fs.statSync(rx.partialPath).size, rx.meta.size, 'the partial is the fresh one')
})

test('REGRESSION (MIR-13): a receive whose folder must exist never recreates it', async (t) => {
  const rx = await receiver(t)
  fs.rmSync(path.dirname(rx.targetPath), { recursive: true, force: true })

  await t.exception(rx.transfer.startReceive(rx.targetPath, rx.meta, { parentMustExist: true }), /receive folder is gone/)
  t.absent(fs.existsSync(path.dirname(rx.targetPath)), 'the deleted folder stays deleted')

  await rx.transfer.startReceive(rx.targetPath, rx.meta)
  t.ok(fs.existsSync(path.dirname(rx.targetPath)), 'without the option the folder is made, as upstream')
})
