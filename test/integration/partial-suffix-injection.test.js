// The partial suffix is app-owned and threaded into the vendored engine as a
// constructor opt (PROVENANCE.md §4.17), so the writer can never drift from the
// app-side sweep/probe/ignore logic that keys on the same constant.
import test from 'brittle'
import { tmpStore, tmpDir, path } from './overlay-vendor-helpers.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'
import { TransferManager, PARTIAL_SUFFIX as VENDOR_DEFAULT_SUFFIX } from '../../src/shared/transfer/backends/overlay/vendor/transfer.js'
import { PARTIAL_SUFFIX } from '../../src/shared/transfer/partial-suffix.js'
import fs from 'bare-fs'

async function setup (transferOpts) {
  const index = new FileIndex(tmpStore('partial-suffix'))
  await index.ready()
  return new TransferManager(index, { journalDir: tmpDir('journals'), ...transferOpts })
}

function senderChunks (transfer, dir, data) {
  const filePath = path.join(dir, 'doc.txt')
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(filePath, data)
  return transfer.prepareFile(filePath, '/doc.txt')
}

test('startReceive writes the injected partial suffix', async (t) => {
  const transfer = await setup({ partialSuffix: '.x.part' })
  const prepared = await senderChunks(transfer, tmpDir('sender'), Buffer.from('payload'))
  const targetPath = path.join(tmpDir('receiver'), 'doc.txt')

  const state = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })

  t.is(state.partialPath, targetPath + '.x.part', 'the host-supplied suffix reaches the on-disk partial')
  t.ok(fs.existsSync(targetPath + '.x.part'), 'partial exists under the injected name')
})

test('startReceive falls back to the vendor default when nothing is injected', async (t) => {
  const transfer = await setup()
  const prepared = await senderChunks(transfer, tmpDir('sender'), Buffer.from('payload'))
  const targetPath = path.join(tmpDir('receiver'), 'doc.txt')

  const state = await transfer.startReceive(targetPath, { size: prepared.size, chunks: prepared.chunks })

  t.ok(state.partialPath.endsWith(VENDOR_DEFAULT_SUFFIX), 'standalone embedder still gets a working default')
})

test('the app injects its own suffix, not the vendor default', async (t) => {
  t.not(PARTIAL_SUFFIX, VENDOR_DEFAULT_SUFFIX, 'app constant is what ships; vendor default is internal only')
})
