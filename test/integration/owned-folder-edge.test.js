import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, listRelPaths } from '../helpers/owned.js'
import { initialPublishScan, periodicReconcile, onFsEvent } from '../../src/shared/folders/owned-folders.js'

// E4 / FIX-4 — a transiently UNREADABLE file (locked by another process, perms
// flap) must not be mistaken for a deletion. walkDisk swallows the read error,
// so the reconcile diff sees the file as "absent" and tombstones it on the
// drive — cascading the deletion to every mirror. RED until FIX-4.
test('REGRESSION (E4): an unreadable file is not deleted by reconcile', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  fs.writeFileSync(path.join(mountPath, 'readable.txt'), 'ok')
  const locked = path.join(mountPath, 'locked.bin')
  fs.writeFileSync(locked, 'secret')
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.alike(await listRelPaths(share, spaceId), ['locked.bin', 'readable.txt'])

  // Make the file unreadable so hashFile throws (EACCES) during walkDisk.
  fs.chmodSync(locked, 0o000)
  t.teardown(() => { try { fs.chmodSync(locked, 0o644) } catch {} })

  const r = await periodicReconcile(spaceId, share.id, mountPath, [])
  t.is(r.deleted, 0, 'no deletions for an unreadable file')
  t.ok((await listRelPaths(share, spaceId)).includes('locked.bin'), 'unreadable file preserved on the drive')
})

// E5 / FIX-5 — editors save via rename-over / delete+recreate, which (with
// atomic:false) surfaces a raw unlink for a path that is immediately back on
// disk. Propagating that unlink as a drive del cascades a deletion to mirrors
// for a file that was never actually removed. RED until FIX-5.
test('REGRESSION (E5): unlink for a path still present on disk does not delete', async (t) => {
  const { spaceId, share, mountPath } = await setupOwnedShare(t)
  const abs = path.join(mountPath, 'doc.md')
  fs.writeFileSync(abs, 'v1')
  await initialPublishScan(spaceId, share.id, mountPath, [])
  t.is((await listRelPaths(share, spaceId)).length, 1)

  // Atomic-save: the file is rewritten and is present on disk when the unlink
  // event is processed.
  fs.writeFileSync(abs, 'v2')
  await onFsEvent(spaceId, share.id, 'unlink', 'doc.md', abs)

  t.ok((await listRelPaths(share, spaceId)).includes('doc.md'), 'entry preserved (file still on disk)')
})
