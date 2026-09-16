import test from 'brittle'
import { setupSelfMirror } from '../helpers/owned.js'
import { folderRequestDownload, setFolderEngine } from '../../src/shared/transfer/backends/overlay/folder-downloads.js'
import { setForeignEnabled } from '../../src/shared/folders/foreign-verbs.js'
import { deleteForeignMount } from '../../src/shared/folders/mount-store.js'

// REGRESSION (FIX-325): a mirrored share syncs itself, so a manual download of one of its files is
// a no-op rather than a second copy in the downloads folder. Only the renderer's role gate stood
// between the two, and the folder screen renders before that role settles.

function stubEngine(t) {
  const calls = { start: 0, clearPauseMarker: 0 }
  setFolderEngine({
    start: async () => { calls.start++; return { transferId: 'stub' } },
    clearPauseMarker: () => { calls.clearPauseMarker++ },
  })
  t.teardown(() => setFolderEngine(null))
  return calls
}

test('REGRESSION (FIX-325): a manual download of a mirrored file is refused as already syncing', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'doc.txt': 'data' } })
  const calls = stubEngine(t)

  const res = await folderRequestDownload(ctx.spaceId, ctx.share, 'doc.txt')
  t.alike(res, { ok: true, mirrored: true }, 'answers with the mirrored no-op')
  t.is(calls.start, 0, 'the engine never starts a transfer')
  t.is(calls.clearPauseMarker, 0, 'the engine is not touched at all')
})

test('REGRESSION (FIX-325): a paused mirror still refuses a manual download', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'doc.txt': 'data' } })
  const calls = stubEngine(t)
  await setForeignEnabled(ctx.spaceId, ctx.share.id, false)

  const res = await folderRequestDownload(ctx.spaceId, ctx.share, 'doc.txt')
  t.alike(res, { ok: true, mirrored: true }, 'presence of the mount decides, not its enabled flag')
  t.is(calls.start, 0, 'the engine never starts a transfer')
})

test('a share with no mirror mount still reaches the download path', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'doc.txt': 'data' } })
  const calls = stubEngine(t)
  await deleteForeignMount(ctx.spaceId, ctx.share.id)

  // A self-mirror has no real peer catalog behind it, so the manual path fails further down; what
  // matters here is that the guard let it through.
  const res = await folderRequestDownload(ctx.spaceId, ctx.share, 'doc.txt').catch(() => null)
  t.absent(res?.mirrored, 'not answered as mirrored')
  t.is(calls.clearPauseMarker, 1, 'the manual path runs')
})
