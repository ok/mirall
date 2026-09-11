import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { initialMaterializeScan, unmountForeignFolder } from '../../src/shared/folders/foreign-folders.js'
import { previewMaterializeScan } from '../../src/shared/folders/foreign-preview.js'
import { initDownloads, markVerified } from '../../src/shared/transfer/files.js'
import { overlayHashFile } from '../../src/shared/transfer/backends/overlay/overlay-backend.js'

// The mount preview's verified-record fast path answers "is the file already here?". A record is
// evidence only when the bytes it vouches for landed at the very path the preview is asking about:
// the key alone names the OWNER's path, which the mirror is free not to write to.

const listing = (dir) => fs.readdirSync(dir).sort()

// A pre-existing user file of the same size as the share's copy: the size check cannot separate
// them, so the verified record decides.
function plantUserFile (abs, content) {
  fs.writeFileSync(abs, content)
  const past = new Date(Date.now() - 60000)
  fs.utimesSync(abs, past, past)
}

test('REGRESSION (FIX-PREVIEW-LOCAL-1): a mirror that landed on a sibling does not clean the preview', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  // The user's own a.txt is already at the destination, so the first mount has to mint a sibling.
  plantUserFile(path.join(ctx.mirrorPath, 'a.txt'), 'bbbb')

  await initialMaterializeScan(ctx.mount)
  t.alike(listing(ctx.mirrorPath), ['a (1).txt', 'a.txt'], 'precondition: the mirror landed on a sibling')

  await unmountForeignFolder(ctx.spaceId, ctx.share.id)

  const preview = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, ctx.mirrorPath)
  t.is(preview.toDownload, 1, 're-mounting would download the file again')
  t.is(preview.conflicts, 1, 'and it would collide with the user file at the natural name')
})

test('REGRESSION (FIX-PREVIEW-LOCAL-2): a manual-download record does not clean a mount preview', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  const dest = ctx.tmpDir('dst')
  // The user downloaded this share file manually earlier: the record is keyed by the share's
  // relPath but the bytes landed in the downloads folder.
  const downloaded = path.join(ctx.tmpDir('downloads'), 'a.txt')
  fs.writeFileSync(downloaded, 'aaaa')
  await markVerified(ctx.spaceId, ctx.share.id + '|a.txt', await overlayHashFile(downloaded), { local: downloaded })
  // An unrelated same-size file of the user's sits at the folder they now want to mount into.
  plantUserFile(path.join(dest, 'a.txt'), 'bbbb')

  const preview = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest)
  t.is(preview.toDownload, 1, 'the download record says nothing about this destination')
  t.is(preview.conflicts, 1, 'the user file at the natural name is still a conflict')
})

test('a legacy verified record (no landing path) is re-hashed rather than trusted', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  await initDownloads()
  const dest = ctx.mirrorPath
  fs.writeFileSync(path.join(dest, 'a.txt'), 'aaaa')
  await markVerified(ctx.spaceId, ctx.share.id + '|a.txt', await overlayHashFile(path.join(dest, 'a.txt')))

  let hashed = 0
  const preview = await previewMaterializeScan(ctx.spaceId, ctx.share.owner, ctx.share.id, dest, {
    hashOf: async (p) => { hashed += 1; return overlayHashFile(p) },
  })
  t.is(hashed, 1, 'the record without a landing path is not evidence on its own')
  t.is(preview.toDownload, 0, 'the hash still proves the file is identical')
})
