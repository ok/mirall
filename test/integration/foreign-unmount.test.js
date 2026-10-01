import test from 'brittle'
import { setupSelfMirror } from '../helpers/owned.js'
import { unmountForeignFolder } from '../../src/shared/folders/foreign-verbs.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { listVerifiedForShare, markVerified } from '../../src/shared/transfer/files.js'
import { entryRef } from '../../src/shared/contract/entry-ref.js'

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

// A mirror's verified rows are the ancestors a re-mount onto the same folder merges against, so a
// user's unmount keeps them; once the share is gone no re-mount can come, and the mirror's rows go
// while a manual download of the same share, addressed absolutely, keeps its row.
async function mirrorWithRows(t) {
  const ctx = await setupSelfMirror(t, { files: { 'doc.txt': 'data' } })
  const shareId = ctx.share.id
  await markVerified(ctx.spaceId, entryRef(shareId, 'mirrored.txt'), 'h1', { local: 'mirrored.txt' })
  await markVerified(ctx.spaceId, entryRef(shareId, 'manual.txt'), 'h2', { local: '/Downloads/manual.txt' })
  await markVerified(ctx.spaceId, entryRef(shareId, 'unaddressed.txt'), 'h3')
  return { ...ctx, shareId }
}

test('a user\'s unmount keeps the mirror\'s verified rows for a re-mount', async (t) => {
  const ctx = await mirrorWithRows(t)
  await unmountForeignFolder(ctx.spaceId, ctx.shareId)
  const left = await listVerifiedForShare(ctx.spaceId, ctx.shareId)
  t.ok(left.has('mirrored.txt'), 'the ancestor survives')
})

test('REGRESSION (FIX-499-VERIFIED): unmounting the mirror of a gone share drops its verified rows, not a manual download\'s', async (t) => {
  const ctx = await mirrorWithRows(t)
  await unmountForeignFolder(ctx.spaceId, ctx.shareId, { shareGone: true })
  const left = await listVerifiedForShare(ctx.spaceId, ctx.shareId)
  t.alike([...left.keys()].sort(), ['manual.txt', 'unaddressed.txt'], 'only the mirror\'s rows are gone')
})
