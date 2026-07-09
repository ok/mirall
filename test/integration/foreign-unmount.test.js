import test from 'brittle'
import { setupSelfMirror } from '../helpers/owned.js'
import { unmountForeignFolder } from '../../src/shared/folders/foreign-folders.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'

// REGRESSION (FIX-UNMOUNT-REFRESH): unmounting reclaims the materialized blobs,
// which changes every file's availability, but it only emitted a mount-status
// event — not share-files-updated — so the folder view's file list never
// refreshed and the status pills stayed "On your device".
test('unmounting a mirror emits share-files-updated so the file list refreshes', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'doc.txt': 'data' } })
  const shareId = ctx.share.id
  const before = ctx.fake.events.length

  await unmountForeignFolder(ctx.spaceId, shareId)

  t.absent(await getForeignMount(ctx.spaceId, shareId), 'mount removed')
  const refreshed = ctx.fake.events
    .slice(before)
    .some((e) => e.type === 'event:share-files-updated' && e.payload?.shareId === shareId)
  t.ok(refreshed, 'share-files-updated emitted on unmount')
})
