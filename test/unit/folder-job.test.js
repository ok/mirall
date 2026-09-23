import test from 'brittle'
import { folderJob, folderLabel } from '../../src/shared/transfer/backends/overlay/folder-job.js'
import { catalogKeyField } from '../../src/shared/shares/catalog-keys.js'
import { entryRef } from '../../src/shared/contract/entry-ref.js'

const KEY = 'ab'.repeat(32)
const base = {
  spaceId: 'S', share: { id: 'sh', name: 'Vault', displayName: 'My Vault', owner: 'OWNER' }, shareId: 'sh', ownerKey: 'OWNER',
  relPath: 'sub/a.bin', pendingKey: '/Vault/sub/a.bin', keyHex: KEY, encrypted: true,
  entry: { contentHash: 'h1', size: 42, seq: 7 }, finalPath: '/dl/sub/a.bin',
}

test('the job carries every field the engine and its audit row read', (t) => {
  const job = folderJob(base)
  t.alike(job, {
    spaceId: 'S', pendingKey: '/Vault/sub/a.bin', path: '/Vault/sub/a.bin', relPath: 'sub/a.bin', shareId: 'sh',
    ...catalogKeyField(KEY, true),
    folderName: 'My Vault',
    transferId: 'S|sh|sub/a.bin',
    contentHash: 'h1', size: 42, sourceSeq: 7,
    ownerKey: 'OWNER', verifyKey: entryRef('sh', 'sub/a.bin'),
    finalPath: '/dl/sub/a.bin', prevBytes: 0,
  })
})

test('a partial resumes only into the destination its row recorded', (t) => {
  t.is(folderJob({ ...base, prevFinalPath: '/dl/sub/a.bin', prevBytes: 10 }).prevBytes, 10, 'same destination: resume')
  t.is(folderJob({ ...base, prevFinalPath: '/old/sub/a.bin', prevBytes: 10 }).prevBytes, 0, 're-anchored: from zero')
  t.is(folderJob({ ...base, prevFinalPath: '/dl/sub/a.bin' }).prevBytes, 0, 'a row with no byte count: from zero')
})

test('a missing size or seq degrades to what the engine expects', (t) => {
  const job = folderJob({ ...base, entry: { contentHash: 'h1' } })
  t.is(job.size, 0)
  t.is(job.sourceSeq, undefined)
})

test('the folder label prefers the display name and survives an unreadable descriptor', (t) => {
  t.is(folderLabel({ name: 'Vault', displayName: 'My Vault' }), 'My Vault')
  t.is(folderLabel({ name: 'Vault' }), 'Vault')
  t.is(folderLabel(null), null)
  t.is(folderJob({ ...base, share: null }).folderName, null)
})

test('the job carries the epoch of the catalog it reads, defaulting to 0', (t) => {
  t.is(folderJob(base).catalogEpoch, 0)
  t.is(folderJob({ ...base, epoch: 2 }).catalogEpoch, 2)
  t.absent('catalogEpoch' in folderJob({ ...base, encrypted: false }), 'a plaintext catalog has no epoch')
})
