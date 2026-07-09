import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { setForeignEnabled, runMaterializeTick } from '../../src/shared/folders/foreign-folders.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'

// Pause/resume of a mirror (foreign-folder:set-enabled). Disabling must flip the
// persisted state, stop the loop, and surface a 'paused' status; the tick must
// then no-op. Re-enabling flips it back to 'active' and the tick resumes.
function statuses (ctx, shareId) {
  return ctx.fake.events
    .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
    .map((e) => e.payload.status)
}

test('disabling a mirror pauses it and the tick stops materializing', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'doc.txt': 'data' } })
  const shareId = ctx.share.id

  const mount = await setForeignEnabled(ctx.spaceId, shareId, false)
  t.absent(mount.enabled, 'mount marked disabled')
  t.is(mount.status, 'paused', 'status is paused')
  t.is((await getForeignMount(ctx.spaceId, shareId)).enabled, false, 'persisted as disabled')
  t.ok(statuses(ctx, shareId).includes('paused'), 'paused status surfaced')

  await runMaterializeTick(ctx.spaceId, shareId)
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'doc.txt')), 'disabled mirror does not materialize')
})

test('re-enabling a mirror resumes it and the tick materializes', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'doc.txt': 'data' } })
  const shareId = ctx.share.id
  await setForeignEnabled(ctx.spaceId, shareId, false)

  const mount = await setForeignEnabled(ctx.spaceId, shareId, true)
  t.ok(mount.enabled, 'mount re-enabled')
  t.is(mount.status, 'active', 'status back to active')
  t.ok(statuses(ctx, shareId).includes('active'), 'active status surfaced')

  await runMaterializeTick(ctx.spaceId, shareId)
  t.ok(fs.existsSync(path.join(ctx.mirrorPath, 'doc.txt')), 'mirror materializes after resume')
})
