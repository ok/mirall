import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import {
  initPendingTransfers,
  recordPending,
  getPendingFor,
  recordPendingError,
  clearPending,
  listPendingForSpace,
} from '../../src/shared/transfer/pending-transfers.js'
import { CODES } from '../../src/shared/contract/errors.js'

test('recordPending persists the resume-stable destination', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  await recordPending('space1', '/a.txt', {
    transferId: 't1',
    driveKey: 'deadbeef',
    totalBytes: 100,
    localPath: '/dl/a.txt.mirall.part',
    finalPath: '/dl/a.txt',
    bytesTransferred: 0,
  })
  const row = await getPendingFor('space1', '/a.txt')
  t.is(row.finalPath, '/dl/a.txt', 'finalPath persisted so a resumed download targets the same file')
  t.is(row.transferId, 't1')
  t.is(row.totalBytes, 100)
})

test('pending error lifecycle: set on failure, cleared on a fresh attempt', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  await recordPending('s', '/b.txt', { localPath: '/x', totalBytes: 1 })
  await recordPendingError('s', '/b.txt', CODES.TRANSFER_NETWORK)
  t.is((await getPendingFor('s', '/b.txt')).errorCode, CODES.TRANSFER_NETWORK)
  await recordPending('s', '/b.txt', { localPath: '/x', totalBytes: 1 })
  t.absent((await getPendingFor('s', '/b.txt')).errorCode, 'a fresh attempt records the row anew, without the error')
  await clearPending('s', '/b.txt')
  t.is((await listPendingForSpace('s')).length, 0)
})

test('recordPending persists blobId so reconcile can detect a delete+readd', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  await recordPending('space1', '/a.txt', {
    transferId: 't1', driveKey: 'deadbeef', totalBytes: 100,
    localPath: '/dl/a.txt.mirall.part', finalPath: '/dl/a.txt', bytesTransferred: 0,
    blobId: 'hash-of-original',
  })
  const row = await getPendingFor('space1', '/a.txt')
  t.is(row.blobId, 'hash-of-original', 'blob identity pinned at download start')
})
