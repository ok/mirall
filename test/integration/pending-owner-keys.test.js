import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { recordPending, recordPendingError } from '../../src/shared/transfer/pending-transfers.js'
import { listAwaitedOwnerKeys } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import { CODES } from '../../src/shared/contract/errors.js'

// REGRESSION (FIX-447: stalled-owner rescue counts terminal rows). A row only the user can unblock
// kept its offline owner in the rescue set, so the convergence tick refreshed that owner forever.
// A permission row whose folder takes writes again is the exception: the next reconnect re-drives it.
test('the stalled-owner rescue skips terminal rows unless the folder is writable again', async (t) => {
  const { downloads } = await freshPeer(t)
  const readOnly = path.join(downloads, 'read-only')
  const writable = path.join(downloads, 'writable')
  fs.mkdirSync(readOnly, { recursive: true })
  fs.mkdirSync(writable, { recursive: true })
  fs.chmodSync(readOnly, 0o555)
  t.teardown(() => fs.chmodSync(readOnly, 0o755))

  const rows = [
    ['disk-full', path.join(writable, 'a.bin'), CODES.TRANSFER_DISK_FULL],
    ['perm-read-only', path.join(readOnly, 'b.bin'), CODES.TRANSFER_PERMISSION],
    ['perm-writable', path.join(writable, 'c.bin'), CODES.TRANSFER_PERMISSION],
    ['download-failed', path.join(writable, 'd.bin'), CODES.DOWNLOAD_FAILED],
    ['no-code', path.join(writable, 'e.bin'), null],
  ]
  for (const [ownerKey, finalPath, code] of rows) {
    await recordPending('space1', ownerKey, { ownerKey, finalPath, bytesTransferred: 0 })
    if (code) await recordPendingError('space1', ownerKey, code)
  }

  const owners = [...await listAwaitedOwnerKeys()].sort()
  t.alike(owners, ['download-failed', 'no-code', 'perm-writable'])
})
