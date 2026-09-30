import test from 'brittle'
import { createStreamingHasher, hashChunk } from '../../src/shared/transfer/overlay/engine/chunker.js'
import { encodeJournal, loadJournal, JOURNAL_MAGIC } from '../../src/shared/transfer/overlay/engine/transfer/journal.js'
import { indexCoreName } from '../../src/shared/transfer/overlay/engine/store/file-index.js'
import { tmpDir, fs, path } from './overlay-engine-helpers.js'

// The resume journal's bytes as released builds write them: a change here strands every paused
// download on an upgrade, so the layout moves only with a reviewed change to this literal.
const GOLDEN_JOURNAL_HEX = '33564a4d80010000142f702f782e62696e2e6d6972616c6c2e706172740c0000000000000003000000abababababababababababababababababababababababababababababababab010000000000000000000000000105'

const pinnedState = () => ({ total: 3, bitmap: Buffer.from([0b101]), contentHash: 'ab'.repeat(32), hasher: null, partialPath: '/p/x.bin.mirall.part', size: 12, hashFrontier: 1 })

test('the resume journal is byte-stable', (t) => {
  const buf = encodeJournal(pinnedState())
  t.is(buf.toString('hex'), GOLDEN_JOURNAL_HEX)
  t.is(buf.readUInt32LE(0), 0x4d4a5633)
  t.is(JOURNAL_MAGIC, 0x4d4a5633)
})

test('a journal with a live hasher round-trips through loadJournal', (t) => {
  const data = Buffer.from('twelve bytes')
  const contentHash = hashChunk(data)
  const hasher = createStreamingHasher({ size: data.length })
  hasher.update(data.subarray(0, 4))
  const partialPath = path.join(tmpDir('journal-pin'), 'x.bin.mirall.part')
  const journalPath = partialPath + '.journal'
  const state = { total: 3, bitmap: Buffer.from([0b001]), contentHash, hasher, partialPath, size: data.length, hashFrontier: 1 }
  fs.writeFileSync(journalPath, encodeJournal(state))
  const chunks = [{ hash: 'a', offset: 0, length: 4 }, { hash: 'b', offset: 4, length: 4 }, { hash: 'c', offset: 8, length: 4 }]
  const loaded = loadJournal(journalPath, partialPath, { size: data.length, chunks, contentHash })
  t.ok(loaded, 'the journal is accepted for its own partial and content')
  t.alike([...loaded.received], [0])
  t.is(loaded.hashFrontier, 1)
  t.is(loaded.hasherBytes, 4)
  const resumed = createStreamingHasher({ size: data.length, restore: { state: loaded.hasherState, bytes: loaded.hasherBytes } })
  resumed.update(data.subarray(4))
  t.is(resumed.digest(), contentHash, 'the restored snapshot continues the same digest')
  t.is(loadJournal(journalPath, partialPath + '.other', { size: data.length, chunks, contentHash }), null, 'another partial is refused')
})

test('local index core names are frozen', (t) => {
  t.is(indexCoreName(1), 'file-index')
  t.is(indexCoreName(2), 'file-index-v2')
})
