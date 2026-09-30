import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { getJournalDir, hasResumeJournal, discardResumeJournal, sweepOrphanedJournals } from '../../src/shared/transfer/backends/overlay/overlay-journals.js'
import { TransferManager } from '../../src/shared/transfer/backends/overlay/engine/transfer/transfer-manager.js'
import { hashChunk } from '../../src/shared/transfer/backends/overlay/engine/chunker.js'

// A paused receive into `dir`, journalled where the app keeps journals.
async function pausedReceive(dir, name) {
  const data = crypto.randomBytes(4096)
  const target = path.join(dir, name)
  const transfer = new TransferManager(null, { journalDir: getJournalDir(), partialSuffix: '.mirall.part' })
  await transfer.startReceive(target, {
    size: data.length,
    contentHash: crypto.data(data).toString('hex'),
    chunks: [{ hash: hashChunk(data), offset: 0, length: data.length }],
  })
  await transfer.pause(target)
  return { target, partial: target + '.mirall.part' }
}

// First, while no store has been opened in this process.
test('with no open store every journal door answers "none" without throwing', (t) => {
  t.execution(() => {
    t.is(hasResumeJournal('/nowhere/file.bin'), false)
    discardResumeJournal('/nowhere/file.bin')
    t.alike(sweepOrphanedJournals(), [])
  })
})

test('a paused receive leaves a journal the app finds by final path, and discarding it is idempotent', async (t) => {
  const { tmpDir } = await freshPeer(t)
  const dir = tmpDir('dl')
  t.is(hasResumeJournal(path.join(dir, 'a.bin')), false, 'no journal before a receive')
  const { target } = await pausedReceive(dir, 'a.bin')
  t.ok(hasResumeJournal(target), 'the pause journalled it')
  discardResumeJournal(target)
  t.is(hasResumeJournal(target), false, 'discarded')
  t.execution(() => discardResumeJournal(target), 'a second discard is a no-op')
})

test('the orphan sweep drops a journal whose partial is gone and keeps one whose partial exists', async (t) => {
  const { tmpDir } = await freshPeer(t)
  const dir = tmpDir('dl')
  const kept = await pausedReceive(dir, 'kept.bin')
  const orphan = await pausedReceive(dir, 'orphan.bin')
  fs.unlinkSync(orphan.partial)
  const swept = sweepOrphanedJournals()
  t.is(swept.length, 1, 'one journal swept')
  t.is(hasResumeJournal(orphan.target), false, 'the orphan went')
  t.ok(hasResumeJournal(kept.target), 'the resumable one stayed')
})
