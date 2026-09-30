import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { initialMaterializeScan, runMaterializeTick } from '../../src/shared/folders/mirror-pass.js'
import { runPublishPass } from '../../src/shared/folders/owned-pass.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initDownloads, markVerified } from '../../src/shared/transfer/files.js'
import { PARTIAL_SUFFIX } from '../../src/shared/transfer/partial-suffix.js'
import { entryRef } from '../../src/shared/contract/entry-ref.js'

// The owner's delete of a row reaches the mirror as "a synced key the catalog no longer lists". It
// may remove only the bytes the mirror delivered there and can still vouch for.

async function ownerDeletes(ctx, rel) {
  fs.unlinkSync(path.join(ctx.mountPath, rel))
  await runPublishPass(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
}

function withListing(t, rewrite) {
  const orig = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async (...a) => {
    const res = await orig(...a)
    return { ...res, entries: res.entries.map(rewrite) }
  }
  t.teardown(() => { overlayBackend.listPeerWithMeta = orig })
}

function failFetchOf(t, ctx, rel) {
  const overlay = getOverlay()
  const orig = overlay.fetchFile
  overlay.fetchFile = async (contentHash, opts) => {
    const { entries } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
    if (entries.find((e) => e.relPath === rel)?.contentHash === contentHash) throw new Error('holder went away')
    return await orig(contentHash, opts)
  }
  t.teardown(() => { overlay.fetchFile = orig })
}

// Moves the mtime past the verified record, so only a hash can say whose bytes these are.
function touch(abs, content = null) {
  if (content !== null) fs.writeFileSync(abs, content)
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(abs, future, future)
}

function readOrNull(abs) {
  try { return fs.readFileSync(abs, 'utf8') } catch { return null }
}

function isLink(abs) {
  try { return fs.lstatSync(abs).isSymbolicLink() } catch { return false }
}

async function mountRecord(ctx) {
  return await getForeignMount(ctx.spaceId, ctx.share.id)
}

async function mirrored(t, files) {
  const ctx = await setupSelfMirror(t, { files: { 'keep.txt': 'stays listed', ...files } })
  await initDownloads()
  return ctx
}

test('REGRESSION (MIR-50): a row that never landed is not owned, so its delete spares the user file', async (t) => {
  const ctx = await mirrored(t, { 'x.txt': 'owner-bytes' })
  withListing(t, (e) => (e.relPath === 'x.txt' ? { ...e, contentHash: null } : e))
  await initialMaterializeScan(ctx.mount)
  t.absent((await mountRecord(ctx)).syncedPaths.includes('x.txt'), 'a still-hashing row is not recorded as synced')

  const abs = path.join(ctx.mirrorPath, 'x.txt')
  fs.writeFileSync(abs, 'the user file')
  await ownerDeletes(ctx, 'x.txt')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.is(readOrNull(abs), 'the user file', 'the user file survives the owner delete')
})

test('REGRESSION (MIR-50): a minted sibling whose fetch failed is neither mapped nor owned', async (t) => {
  const ctx = await mirrored(t, { 'r.pdf': 'owner-bytes' })
  fs.writeFileSync(path.join(ctx.mirrorPath, 'r.pdf'), 'the user r.pdf')
  failFetchOf(t, ctx, 'r.pdf')
  await initialMaterializeScan(ctx.mount)

  const rec = await mountRecord(ctx)
  t.absent(rec.renamedPaths?.['r.pdf'], 'no collision mapping for a sibling that never landed')
  t.absent(rec.syncedPaths.includes('r.pdf'), 'and no ownership')

  const sibling = path.join(ctx.mirrorPath, 'r (1).pdf')
  fs.writeFileSync(sibling, 'the user sibling')
  await ownerDeletes(ctx, 'r.pdf')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.is(readOrNull(sibling), 'the user sibling', 'the user file at the sibling name survives')
  t.is(readOrNull(path.join(ctx.mirrorPath, 'r.pdf')), 'the user r.pdf', 'and so does the one at the natural name')
})

test('REGRESSION (MIR-50): a locally edited mirrored file survives the owner delete', async (t) => {
  const ctx = await mirrored(t, { 'a.txt': 'owner-bytes' })
  await initialMaterializeScan(ctx.mount)
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  t.is(fs.readFileSync(abs, 'utf8'), 'owner-bytes', 'precondition: mirrored')

  touch(abs, 'my own edit')
  await ownerDeletes(ctx, 'a.txt')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.is(readOrNull(abs), 'my own edit', 'the edit is kept')
  t.absent((await mountRecord(ctx)).syncedPaths.includes('a.txt'), 'and the mirror stops tracking it')
})

test('an untouched mirrored file is removed with the owner copy', async (t) => {
  const ctx = await mirrored(t, { 'a.txt': 'owner-bytes', 'b.txt': 'more owner bytes' })
  await initialMaterializeScan(ctx.mount)
  // Same bytes, new mtime: the fingerprint no longer vouches, the hash still does.
  touch(path.join(ctx.mirrorPath, 'b.txt'))

  await ownerDeletes(ctx, 'a.txt')
  await ownerDeletes(ctx, 'b.txt')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'a.txt')), 'the fingerprinted copy is removed')
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'b.txt')), 'the re-timed copy is removed on its hash')
  const rec = await mountRecord(ctx)
  t.alike(rec.syncedPaths, ['keep.txt'], 'only the listed file is still owned')
})

test('a mirrored file replaced by a symlink is left alone', { skip: Bare.platform === 'win32' }, async (t) => {
  const ctx = await mirrored(t, { 'a.txt': 'owner-bytes' })
  await initialMaterializeScan(ctx.mount)
  const outside = path.join(ctx.tmpDir('outside'), 'target.txt')
  fs.writeFileSync(outside, 'not the mirror bytes')
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  fs.unlinkSync(abs)
  fs.symlinkSync(outside, abs)

  await ownerDeletes(ctx, 'a.txt')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.ok(isLink(abs), 'the link is not the mirror copy, so it stays')
  t.is(fs.readFileSync(outside, 'utf8'), 'not the mirror bytes', 'and its target is untouched')
})

test('an interrupted fetch into a sibling resumes into the same sibling', async (t) => {
  const ctx = await mirrored(t, { 'r.pdf': 'owner-bytes' })
  fs.writeFileSync(path.join(ctx.mirrorPath, 'r.pdf'), 'the user r.pdf')
  const overlay = getOverlay()
  const orig = overlay.fetchFile
  const dests = []
  overlay.fetchFile = async (contentHash, opts) => {
    if (!opts.destPath.endsWith('.pdf')) return await orig(contentHash, opts)
    dests.push(path.basename(opts.destPath))
    if (dests.length > 1) return await orig(contentHash, opts)
    fs.writeFileSync(opts.destPath + PARTIAL_SUFFIX, 'half')
    throw new Error('holder went away')
  }
  t.teardown(() => { overlay.fetchFile = orig })

  await initialMaterializeScan(ctx.mount)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.alike(dests, ['r (1).pdf', 'r (1).pdf'], 'the retry goes to the sibling whose partial it left')
  t.is((await mountRecord(ctx)).renamedPaths?.['r.pdf'], 'r (1).pdf', 'and the landing claims it')
})

test('REGRESSION (MIR-50): a landing record without a fingerprint never vouches for a replaced file', async (t) => {
  const ctx = await mirrored(t, { 'a.txt': 'owner-bytes' })
  await initialMaterializeScan(ctx.mount)
  const key = entryRef(ctx.share.id, 'a.txt')
  const { entries } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  await markVerified(ctx.spaceId, key, entries.find((e) => e.relPath === 'a.txt').contentHash, { local: 'a.txt' })
  // A restore that carries an old mtime: older than the record, which is all a bare record can ask.
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  fs.writeFileSync(abs, 'restored from a backup')
  const past = new Date(Date.now() - 86400000)
  fs.utimesSync(abs, past, past)

  await ownerDeletes(ctx, 'a.txt')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.is(readOrNull(abs), 'restored from a backup', 'judged on its hash, and kept')
})

test('a copy that cannot be read this time stays claimed for the next pass', { skip: Bare.platform === 'win32' }, async (t) => {
  const ctx = await mirrored(t, { 'a.txt': 'owner-bytes' })
  await initialMaterializeScan(ctx.mount)
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  touch(abs)
  fs.chmodSync(abs, 0o000)
  t.teardown(() => { try { fs.chmodSync(abs, 0o644) } catch {} })

  await ownerDeletes(ctx, 'a.txt')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.ok(fs.existsSync(abs), 'an unreadable copy is not deleted')
  t.ok((await mountRecord(ctx)).syncedPaths.includes('a.txt'), 'and the claim is kept')

  fs.chmodSync(abs, 0o644)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.absent(fs.existsSync(abs), 'once readable it is judged ours and removed')
})
