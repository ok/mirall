import test from 'brittle'
import { tmpStore, tmpDir, fs, path } from './overlay-engine-helpers.js'
import { FileIndex } from '../../src/shared/transfer/overlay/engine/store/file-index.js'
import { TransferManager } from '../../src/shared/transfer/overlay/engine/transfer/transfer-manager.js'

// Every byte can arrive before the whole-file hash has covered them: the hash runs in chunk order,
// so one early chunk arriving last leaves the rest to be read back and hashed at finalize. That
// catch-up reports as verifying progress, so a row does not sit at 100% while nothing moves; a
// receive that kept pace reports nothing.

const MB = 1024 * 1024

async function receiver(t, { memStashBytes } = {}) {
  const index = new FileIndex(tmpStore('finalize-verify'))
  await index.ready()
  const transfer = new TransferManager(index, { journalDir: tmpDir('journals'), memStashBytes })
  const dir = tmpDir('src')
  fs.mkdirSync(dir, { recursive: true })
  const src = path.join(dir, 'f.bin')
  const data = Buffer.alloc(96 * MB)
  for (let i = 0; i < data.length; i += 4096) data.writeUInt32LE((i * 2654435761) >>> 0, i)
  fs.writeFileSync(src, data)
  const prep = await transfer.prepareFile(src)
  const dest = path.join(tmpDir('dst'), 'f.bin')
  await transfer.startReceive(dest, { size: data.length, chunks: prep.chunks, contentHash: prep.contentHash })
  const write = (i) => {
    const c = prep.chunks[i]
    return transfer.writeChunk(dest, i, data.subarray(c.offset, c.offset + c.length))
  }
  return { transfer, prep, dest, write }
}

test('a finalize that has to catch the hash up reports it as verifying progress, ending at 1', async (t) => {
  const { transfer, prep, dest, write } = await receiver(t, { memStashBytes: 1 * MB })
  for (let i = 1; i < prep.chunks.length; i++) write(i)
  write(0)
  const reports = []
  const fin = await transfer.finalize(dest, { onVerify: (fraction) => reports.push(fraction) })
  t.ok(fin.ok, 'the file is complete and verified')
  t.ok(reports.length >= 3, `progress was reported while the hash caught up (${reports.length} reports)`)
  t.ok(reports[0] < 0.1, 'it starts from how little was hashed during the receive')
  t.is(reports.at(-1), 1, 'and ends at the whole file')
  t.ok(reports.every((f, i) => i === 0 || f >= reports[i - 1]), 'never going backwards')
})

test('a receive whose hash kept pace finalizes without a verifying report', async (t) => {
  const { transfer, prep, dest, write } = await receiver(t)
  for (let i = 0; i < prep.chunks.length; i++) write(i)
  const reports = []
  const fin = await transfer.finalize(dest, { onVerify: (fraction) => reports.push(fraction) })
  t.ok(fin.ok)
  t.alike(reports, [], 'nothing to catch up, so no verifying phase')
})
