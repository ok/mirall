import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { initialMaterializeScan, materializeCatalogFile } from '../../src/shared/folders/foreign-folders.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { initDownloads } from '../../src/shared/transfer/files.js'

// D2 — a mirror stays owner-authoritative, but a user's bytes are no longer destroyed to get there.
//
// test/flow/mirror-local-edit.test.js pins the doctrine: the owner's version belongs at the natural
// name. That part is deliberate and unchanged here. What was never intended is the other half — the
// old code renamed the fetched bytes straight over the local file, so an edit inside a mirrored
// folder vanished on the next 30 s tick with no copy, no warning and no audit row.
//
// materializeOverlayFile had two "already correct?" tests and both compared the disk against
// `entry.contentHash`, the OWNER's current hash. Failing both means only "this is not the owner's
// current version" — equally true when the owner edited the file and when the user edited ours.
//
// The evidence to tell them apart was already durable: markVerified() records the hash the mirror
// actually DELIVERED, per file, for the life of the mount. It was written on every landing and only
// ever read back against the owner's hash — getVerifiedHash had no caller anywhere in src/.

async function entryFor (ctx) {
  const { entries: [entry] } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  return entry
}

// Edit the mirrored copy the way a user would: new bytes, and an mtime after the verified record
// so the fast-path cache correctly declines to vouch for it.
function userEdits (abs, content) {
  fs.writeFileSync(abs, content)
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(abs, future, future)
}

test('REGRESSION (FIX-D2-1): a locally-edited mirror file is preserved, not destroyed', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'owner-bytes' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  t.is(fs.readFileSync(abs, 'utf8'), 'owner-bytes', 'precondition: the mirror delivered the file')

  userEdits(abs, 'my own edit')

  // The owner has changed NOTHING, so the only difference on disk is the user's.
  const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
  await materializeCatalogFile(cur, ctx.share, await entryFor(ctx))

  // Owner-authoritative: the canonical path still ends up with the owner's bytes...
  t.is(fs.readFileSync(abs, 'utf8'), 'owner-bytes', 'the owner version holds the natural name')
  // ...but the user's edit was moved aside instead of being overwritten in place.
  const conflict = path.join(ctx.mirrorPath, 'a (conflicted copy).txt')
  t.ok(fs.existsSync(conflict), 'the local edit was preserved as a conflict copy')
  t.is(fs.readFileSync(conflict, 'utf8'), 'my own edit', 'byte-exact')
})

test('REGRESSION (FIX-D2-2): the mirror converges on the owner version at the canonical path', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'owner-bytes' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  userEdits(abs, 'my own edit')

  const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
  await materializeCatalogFile(cur, ctx.share, await entryFor(ctx))

  t.is(fs.readFileSync(abs, 'utf8'), 'owner-bytes', 'the mirror re-materialized the owner version')

  // No rename mapping is minted: the mirror still owns the natural name, so nothing about its
  // bookkeeping changes and an unmount/re-mount adopts the same path as before.
  const after = await getForeignMount(ctx.spaceId, ctx.share.id)
  t.absent(after.renamedPaths?.['a.txt'], 'the mirror kept owning the canonical path')
})

test('D2: repeated ticks do not pile up conflict copies', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'owner-bytes' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  userEdits(abs, 'my own edit')

  for (let i = 0; i < 3; i++) {
    const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
    await materializeCatalogFile(cur, ctx.share, await entryFor(ctx))
  }

  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'a (conflicted copy) (1).txt')), 'only one conflict copy')
  t.is(fs.readFileSync(abs, 'utf8'), 'owner-bytes', 'the canonical path settled on the owner version')
  t.is(fs.readFileSync(path.join(ctx.mirrorPath, 'a (conflicted copy).txt'), 'utf8'), 'my own edit',
    'and the single preserved edit is untouched by later ticks')
})

// The guard must not freeze normal syncing: an UNMODIFIED mirror copy is still ours, so an owner
// edit overwrites it in place exactly as before. Without this the fix would trade data loss for a
// mirror that never updates.
test('D2: an owner edit still overwrites an untouched mirror copy in place', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'v1' } })
  await initDownloads()
  await initialMaterializeScan(ctx.mount)

  const abs = path.join(ctx.mirrorPath, 'a.txt')
  t.is(fs.readFileSync(abs, 'utf8'), 'v1', 'precondition: v1 mirrored')

  // The owner republishes new bytes; the local copy is untouched.
  fs.writeFileSync(path.join(ctx.mountPath, 'a.txt'), 'v2-from-owner')
  const { initialPublishScan } = await import('../../src/shared/folders/owned-folders.js')
  await initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
  await materializeCatalogFile(cur, ctx.share, await entryFor(ctx))

  t.is(fs.readFileSync(abs, 'utf8'), 'v2-from-owner', 'the owner update landed in place')
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'a (conflicted copy).txt')),
    'no needless conflict copy for an ordinary update')
})

// REGRESSION (FIX-D2-3): the preserve step must not fail open on a path it cannot stat.
//
// The stat before the checks swallowed EVERY error, so anything present-but-unreadable read as
// absent, `localExists` was false, and the fetch renamed over it without a copy — the same fail-open
// shape the boot-sweep fix removed, reproduced inside the guard meant to prevent it. rename() needs
// permission on the DIRECTORY, not the file, so an unstattable file is still perfectly destroyable.
// A directory at the path exercises the same gate deterministically on every platform.
test('REGRESSION (FIX-D2-3): a non-file at the mirror path is moved aside, not written over', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'owner-bytes' } })
  await initDownloads()
  // Mirror it first: a path the mirror has NOT synced is already handled by resolveLocalRelPath,
  // which mints a sibling rather than touching a pre-existing file. The gap is on the synced path,
  // where the resolver returns the natural name without reading the file at all.
  await initialMaterializeScan(ctx.mount)

  // The user replaces our file with a directory of their own.
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  fs.unlinkSync(abs)
  fs.mkdirSync(abs, { recursive: true })
  fs.writeFileSync(path.join(abs, 'inner.txt'), 'user data inside a directory')

  const cur = await getForeignMount(ctx.spaceId, ctx.share.id)
  await materializeCatalogFile(cur, ctx.share, await entryFor(ctx))

  const moved = path.join(ctx.mirrorPath, 'a (conflicted copy).txt')
  t.ok(fs.existsSync(moved), 'the unvouchable directory was moved aside')
  t.is(fs.readFileSync(path.join(moved, 'inner.txt'), 'utf8'), 'user data inside a directory',
    'its contents survived intact')
  t.is(fs.readFileSync(abs, 'utf8'), 'owner-bytes', 'and the owner version took the canonical path')
})
