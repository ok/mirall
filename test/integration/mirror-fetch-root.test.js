import test from 'brittle'
import fs from 'bare-fs'
import { setupSelfMirror } from '../helpers/owned.js'
import { materializeCatalogFile } from '../../src/shared/folders/mirror-pass.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { STATUS_MOUNT_GONE } from '../../src/shared/folders/mount-fault.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'

// A pass probes the mount root once, and the waits after it are unbounded. The mirror makes the
// file's folder itself, so it tells the receive that the folder must already exist: a root the
// user deleted meanwhile must not be recreated by the receive's own mkdir.
test('REGRESSION (MIR-13): a root removed during the fetch is not recreated, and the mount pauses', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'owner-bytes' } })
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  const overlay = getOverlay()
  const orig = overlay.fetchFile
  let asked = null
  // Stands in for the vendor receive, whose refusal is pinned in overlay-engine-partial.test.js.
  overlay.fetchFile = async (contentHash, opts) => {
    asked = opts.parentMustExist
    fs.rmSync(ctx.mirrorPath, { recursive: true, force: true })
    const err = new Error('receive folder is gone')
    err.code = 'ENOENT'
    throw err
  }
  t.teardown(() => { overlay.fetchFile = orig })

  const outcome = await materializeCatalogFile(ctx.mount, ctx.share, entry)

  t.is(asked, true, 'the mirror asks the receive not to create the folder')
  t.not(outcome, 'present', 'nothing landed')
  t.absent(fs.existsSync(ctx.mirrorPath), 'the root was not recreated')
  const mount = await getForeignMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, STATUS_MOUNT_GONE, 'the mount pauses as gone')
})
