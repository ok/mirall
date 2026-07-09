import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import {
  initPendingTransfers,
  recordPending,
  getPendingFor,
  recordPendingError,
  clearPendingError,
  clearPending,
  listPendingForSpace,
} from '../../src/shared/transfer/pending-transfers.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'

test('recordPending persists the resume-stable destination', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  await recordPending('space1', '/a.txt', {
    transferId: 't1',
    driveKey: 'deadbeef',
    totalBytes: 100,
    localPath: '/dl/a.txt.partial',
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
  await recordPendingError('s', '/b.txt', ErrorCodes.TRANSFER_NETWORK)
  t.is((await getPendingFor('s', '/b.txt')).errorCode, ErrorCodes.TRANSFER_NETWORK)
  await clearPendingError('s', '/b.txt')
  t.absent((await getPendingFor('s', '/b.txt')).errorCode, 'error wiped when the user retries')
  await clearPending('s', '/b.txt')
  t.is((await listPendingForSpace('s')).length, 0)
})

test('recordPending persists blobId so reconcile can detect a delete+readd', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  await recordPending('space1', '/a.txt', {
    transferId: 't1', driveKey: 'deadbeef', totalBytes: 100,
    localPath: '/dl/a.txt.partial', finalPath: '/dl/a.txt', bytesTransferred: 0,
    blobId: 'hash-of-original',
  })
  const row = await getPendingFor('space1', '/a.txt')
  t.is(row.blobId, 'hash-of-original', 'blob identity pinned at download start')
})
