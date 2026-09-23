import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror, instrumentWalks } from '../helpers/owned.js'
import { waitFor } from '../helpers/bare-poll.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { MAIN_REQUEST, MAIN_REQUEST_FRAME } from '../../src/shared/contract/main-requests.js'
import { initialMaterializeScan, runMaterializeTick } from '../../src/shared/folders/mirror-pass.js'
import { startForeignLoop, stopForeignLoop, setForeignEnabled } from '../../src/shared/folders/foreign-verbs.js'
import { handleMirrorFsEvent } from '../../src/shared/folders/mirror-watcher.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { initDownloads } from '../../src/shared/transfer/files.js'

// A converged mirror skips its ticks until the owner's catalog version moves, and a local write
// never moves it. The disk watcher is what turns that write into a walk; these cases drive its
// worker-side handler directly, the way the flow layer injects main's events.

// A live loop with a poll that never fires within the test: only the request can walk.
// `beforeStart` runs against the empty mirror folder, before the loop and the scan.
async function liveConvergedMirror(t, files, { beforeStart = () => {} } = {}) {
  const ctx = await setupSelfMirror(t, { files })
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, foreignPollIntervalMs: 600_000 })
  t.teardown(() => setRuntimeConfig(cfg))
  await initDownloads()
  const walks = instrumentWalks(t)
  beforeStart(ctx)
  await startForeignLoop(ctx.mount)
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id))
  await initialMaterializeScan(ctx.mount)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  const settled = walks.listings
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  t.is(walks.listings, settled, 'precondition: the mirror converged and skips')
  return { ctx, walks }
}

function userEdits(abs, body) {
  fs.writeFileSync(abs, body)
  const future = new Date(Date.now() + 60000)
  fs.utimesSync(abs, future, future)
}

const fsEvent = (ctx, action, relPath) => handleMirrorFsEvent({ spaceId: ctx.spaceId, shareId: ctx.share.id, action, relPath })

// REGRESSION (FIX-462: a local-only edit of a mirrored file was reverted only by the full-walk
// backstop — about five minutes at the default poll — unless the user opened the folder view,
// whose listing was the one reader asking for a walk.)
test('REGRESSION (FIX-462): a local edit is walked on the watcher event, with no listing and no backstop', async (t) => {
  const { ctx } = await liveConvergedMirror(t, { 'a.txt': 'aaaa' })
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  userEdits(abs, 'cccc')

  await fsEvent(ctx, 'change', 'a.txt')

  const conflicted = path.join(ctx.mirrorPath, 'a (conflicted copy).txt')
  await waitFor(() => fs.existsSync(conflicted), 5000, { label: 'the requested walk' })
  t.is(fs.readFileSync(conflicted, 'utf8'), 'cccc', 'the edit is kept aside')
  t.is(fs.readFileSync(abs, 'utf8'), 'aaaa', 'and the owner’s version is back')
})

test('a locally deleted mirror file is fetched back on the watcher event', async (t) => {
  const { ctx } = await liveConvergedMirror(t, { 'a.txt': 'aaaa' })
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  fs.unlinkSync(abs)

  await fsEvent(ctx, 'unlink', 'a.txt')

  await waitFor(() => fs.existsSync(abs), 5000, { label: 'the requested walk' })
  t.is(fs.readFileSync(abs, 'utf8'), 'aaaa')
})

// The watcher sees the mirror's own landings too. A file that is exactly the one the verified
// record fingerprinted is ours, and must not cost the walk it would then re-trigger on every fetch.
test('the mirror’s own landing requests no walk', async (t) => {
  const { ctx, walks } = await liveConvergedMirror(t, { 'a.txt': 'aaaa' })
  const before = walks.listings

  await fsEvent(ctx, 'add', 'a.txt')
  await fsEvent(ctx, 'change', 'a.txt')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.is(walks.listings, before, 'the watermark stood: the tick skipped')
})

// A path the mirror never wrote is nothing a walk could act on — a user's own file beside the
// mirrored ones, or the conflicted copy a revert left behind — however often it is saved.
test('a file the mirror never wrote requests no walk, edited or deleted', async (t) => {
  const { ctx, walks } = await liveConvergedMirror(t, { 'a.txt': 'aaaa' })
  const own = path.join(ctx.mirrorPath, 'notes.md')
  fs.writeFileSync(own, 'mine')
  const before = walks.listings

  await fsEvent(ctx, 'add', 'notes.md')
  fs.writeFileSync(own, 'mine, again')
  await fsEvent(ctx, 'change', 'notes.md')
  fs.unlinkSync(own)
  await fsEvent(ctx, 'unlink', 'notes.md')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.is(walks.listings, before, 'the watermark stood')
})

// A collision sibling is recorded under the owner's key; the event names the sibling.
test('a landing at a collision sibling is recognised as the mirror’s own', async (t) => {
  const { ctx, walks } = await liveConvergedMirror(t, { 'b.txt': 'owner-bytes' }, {
    beforeStart: (c) => fs.writeFileSync(path.join(c.mirrorPath, 'b.txt'), 'the user was here first'),
  })
  const sibling = (await getForeignMount(ctx.spaceId, ctx.share.id)).renamedPaths?.['b.txt']
  t.ok(sibling && sibling !== 'b.txt', 'precondition: the owner’s file landed at a sibling')
  const before = walks.listings

  await fsEvent(ctx, 'add', sibling)
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.is(walks.listings, before, 'no walk for the sibling’s landing')
})

test('a paused mirror ignores the event', async (t) => {
  const { ctx } = await liveConvergedMirror(t, { 'a.txt': 'aaaa' })
  await setForeignEnabled(ctx.spaceId, ctx.share.id, false)
  const abs = path.join(ctx.mirrorPath, 'a.txt')
  userEdits(abs, 'cccc')

  await fsEvent(ctx, 'change', 'a.txt')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'a (conflicted copy).txt')))
  t.is(fs.readFileSync(abs, 'utf8'), 'cccc', 'the edit stands while the mirror is paused')
})

// The watcher runs in Electron main, armed over the bus by the same verbs that arm the loop.
test('starting and stopping the loop arms and disarms the watcher', async (t) => {
  const ctx = await setupSelfMirror(t, { files: { 'a.txt': 'aaaa' } })
  const frames = []
  const off = ctx.fake.onEmit((frame) => { if (frame.type === MAIN_REQUEST_FRAME) frames.push(frame.payload) })
  t.teardown(off)

  await startForeignLoop(ctx.mount)
  stopForeignLoop(ctx.spaceId, ctx.share.id)

  t.alike(frames, [
    { command: MAIN_REQUEST.FOREIGN_FOLDER_START_WATCHER, args: { spaceId: ctx.spaceId, shareId: ctx.share.id, mountPath: ctx.mirrorPath } },
    { command: MAIN_REQUEST.FOREIGN_FOLDER_STOP_WATCHER, args: { spaceId: ctx.spaceId, shareId: ctx.share.id } },
  ])
})
