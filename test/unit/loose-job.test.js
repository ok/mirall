import test from 'brittle'
import { looseJob, looseRelPath, looseDrivePath } from '../../src/shared/transfer/backends/overlay/loose-job.js'
import { entryRef } from '../../src/shared/contract/entry-ref.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

const base = {
  spaceId: 'S', ownerKey: 'OWNER', relPath: 'a.bin', pendingKey: '/a.bin',
  entry: { contentHash: 'h1', size: 42, seq: 7 }, finalPath: '/dl/a.bin',
}

test('the job carries every field the engine and its audit row read', (t) => {
  t.alike(looseJob(base), {
    spaceId: 'S', pendingKey: '/a.bin', path: '/a.bin', relPath: 'a.bin',
    transferId: 'S|' + LOOSE_SHARE_ID + '|a.bin',
    contentHash: 'h1', size: 42, sourceSeq: 7,
    ownerKey: 'OWNER', verifyKey: entryRef(LOOSE_SHARE_ID, 'a.bin'),
    finalPath: '/dl/a.bin', prevBytes: 0,
  })
})

test('a partial resumes only into the destination its row recorded', (t) => {
  t.is(looseJob({ ...base, prevFinalPath: '/dl/a.bin', prevBytes: 10 }).prevBytes, 10, 'same destination: resume')
  t.is(looseJob({ ...base, prevFinalPath: '/old/a.bin', prevBytes: 10 }).prevBytes, 0, 're-anchored: from zero')
  t.is(looseJob({ ...base, prevFinalPath: '/dl/a.bin' }).prevBytes, 0, 'a row with no byte count: from zero')
})

test('a missing size or seq degrades to what the engine expects', (t) => {
  const job = looseJob({ ...base, entry: { contentHash: 'h1' } })
  t.is(job.size, 0)
  t.is(job.sourceSeq, undefined)
})

test('the drive path and the relPath round-trip', (t) => {
  t.is(looseDrivePath('sub/a.bin'), '/sub/a.bin')
  t.is(looseRelPath('/sub/a.bin'), 'sub/a.bin')
  t.is(looseRelPath('sub/a.bin'), 'sub/a.bin', 'a bare relPath stays')
})
