import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import {
  initPendingTransfers,
  recordPending,
  updatePendingProgress,
  getPendingFor,
  clearPending,
} from '../../src/shared/transfer/pending-transfers.js'
import { pausedStatusFor } from '../../src/shared/transfer/transfer-status.js'

// The share:list-files handler composes three primitives to surface a paused
// row to the renderer: getPendingFor (real bee), isActiveTransfer (in-memory
// map), pausedStatusFor (pure rule). This integration test exercises the
// composition against a real pending-transfers store, since the rule alone is
// covered at the unit layer.

test('paused-interrupted: pending row present, no active transfer, owner online', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()

  await recordPending('space-a', '/Photos/big.bin', {
    transferId: 't1',
    driveKey: 'deadbeef'.repeat(8),
    totalBytes: 1024 * 1024,
    localPath: '/dl/big.bin.mirall.part',
    finalPath: '/dl/big.bin',
    bytesTransferred: 0,
    shareContext: { shareId: 'sh-1', relPath: 'big.bin' },
  })
  await updatePendingProgress('space-a', '/Photos/big.bin', 256 * 1024)

  const row = await getPendingFor('space-a', '/Photos/big.bin')
  const status = pausedStatusFor({ pendingRow: row, isActive: false, ownerOnline: true })
  t.alike(status, { status: 'paused-interrupted', pendingBytes: 256 * 1024 })
})

test('paused-offline when owner offline; null after the row is cleared', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()

  await recordPending('space-b', '/Docs/a.pdf', {
    transferId: 't2',
    driveKey: 'beefdead'.repeat(8),
    totalBytes: 512,
    localPath: '/dl/a.pdf.mirall.part',
    finalPath: '/dl/a.pdf',
    bytesTransferred: 100,
  })

  let row = await getPendingFor('space-b', '/Docs/a.pdf')
  t.alike(
    pausedStatusFor({ pendingRow: row, isActive: false, ownerOnline: false }),
    { status: 'paused-offline', pendingBytes: 100 }
  )

  await clearPending('space-b', '/Docs/a.pdf')
  row = await getPendingFor('space-b', '/Docs/a.pdf')
  t.is(pausedStatusFor({ pendingRow: row, isActive: false, ownerOnline: true }), null,
    'after discardPartial cleared the row, status returns to non-paused')
})

test('shareContext is persisted on the pending row so resume can re-emit download progress', async (t) => {
  await freshPeer(t)
  await initPendingTransfers()
  const ctx = { shareId: 'sh-42', relPath: 'nested/file.dat' }
  await recordPending('space-c', '/Owner/nested/file.dat', {
    transferId: 't3',
    driveKey: 'aabb'.repeat(16),
    totalBytes: 1000,
    localPath: '/dl/file.dat.mirall.part',
    finalPath: '/dl/file.dat',
    bytesTransferred: 0,
    shareContext: ctx,
  })
  const row = await getPendingFor('space-c', '/Owner/nested/file.dat')
  t.alike(row.shareContext, ctx, 'resumeTransfersForDriveKey reads this back into startDownload')
})
