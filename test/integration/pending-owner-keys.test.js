import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { recordPending, recordPendingError, listPendingOwnerKeys } from '../../src/shared/transfer/pending-transfers.js'
import { createOverlayDownloadEngine } from '../../src/shared/transfer/backends/overlay/overlay-download.js'
import { folderChannel } from '../../src/shared/transfer/backends/overlay/folder-downloads.js'
import { transferIdFor } from '../../src/shared/transfer/transfer-id.js'
import { CODES } from '../../src/shared/contract/errors.js'

const SPACE = 'space1'
const SHARE = 'share1'

async function seed(ownerKey, finalPath, code) {
  await recordPending(SPACE, ownerKey, { ownerKey, finalPath, overlayShare: true, shareId: SHARE, relPath: ownerKey, bytesTransferred: 0 })
  if (code) await recordPendingError(SPACE, ownerKey, code)
}

const awaited = async (engine) => [...await listPendingOwnerKeys({ keep: (row) => engine.awaitsOwner(row) })].sort()

// REGRESSION (FIX-447: stalled-owner rescue counts terminal rows). A row only the user can unblock
// kept its offline owner in the rescue set, so the convergence tick refreshed that owner forever.
// A permission row whose folder takes writes again is the exception, and a checksum row still waits
// on the owner, whose republish is what clears it.
test('the stalled-owner rescue skips rows only the user can unblock', async (t) => {
  const { downloads } = await freshPeer(t)
  const readOnly = path.join(downloads, 'read-only')
  const writable = path.join(downloads, 'writable')
  fs.mkdirSync(readOnly, { recursive: true })
  fs.mkdirSync(writable, { recursive: true })
  fs.chmodSync(readOnly, 0o555)
  t.teardown(() => fs.chmodSync(readOnly, 0o755))

  await seed('disk-full', path.join(writable, 'a.bin'), CODES.TRANSFER_DISK_FULL)
  await seed('dest-unavailable', path.join(downloads, 'gone', 'b.bin'), CODES.TRANSFER_DEST_UNAVAILABLE)
  await seed('perm-read-only', path.join(readOnly, 'c.bin'), CODES.TRANSFER_PERMISSION)
  await seed('perm-missing-folder', path.join(downloads, 'gone', 'd.bin'), CODES.TRANSFER_PERMISSION)
  await seed('perm-writable', path.join(writable, 'e.bin'), CODES.TRANSFER_PERMISSION)
  await seed('checksum', path.join(writable, 'f.bin'), CODES.TRANSFER_CHECKSUM)
  await seed('download-failed', path.join(writable, 'g.bin'), CODES.DOWNLOAD_FAILED)
  await seed('no-code', path.join(writable, 'h.bin'), null)
  await seed('paused', path.join(writable, 'i.bin'), null)

  const engine = createOverlayDownloadEngine(folderChannel)
  engine.pause(transferIdFor(SPACE, SHARE, 'paused'))

  t.alike(await awaited(engine), ['checksum', 'download-failed', 'no-code', 'perm-writable'])
})

test('the rescue reuses a folder verdict for a minute; the reconnect always probes afresh', async (t) => {
  const { downloads } = await freshPeer(t)
  await seed('perm', path.join(downloads, 'x', 'a.bin'), CODES.TRANSFER_PERMISSION)
  let clock = 0
  let writable = false
  const probed = []
  const engine = createOverlayDownloadEngine(folderChannel, {
    now: () => clock,
    dirAcceptsWrite: (dir) => { probed.push(dir); return writable },
  })

  t.alike(await awaited(engine), [])
  writable = true
  clock += 59_000
  t.alike(await awaited(engine), [], 'the kept verdict answers inside the minute')
  t.is(probed.length, 1)
  clock += 1000
  t.alike(await awaited(engine), ['perm'], 'an expired verdict is probed again')
  t.is(probed.length, 2)
})
