import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, listRelPaths } from '../helpers/owned.js'
import { getOwnedMount, patchOwnedMount } from '../../src/shared/folders/mount-store.js'
import { periodicReconcile, onFsEvent, getIndexStatus, cancelIndex } from '../../src/shared/folders/owned-folders.js'

// Pause vs. Stop for an owned folder's index. Both drop the queue; only Pause disarms the
// reconcile cadence and records a durable intent that nothing but an explicit resume clears.

const fileNames = (n) => Array.from({ length: n }, (_, i) => `f${String(i).padStart(4, '0')}.txt`)
const manyFiles = (n) => Object.fromEntries(fileNames(n).map((name) => [name, 'x'.repeat(64)]))

const timerKey = (ctx) => ctx.spaceId + ':' + ctx.share.id
const armed = (ctx) => ctx.root.mounts.periodicTimers.has(timerKey(ctx))
const statuses = (ctx) => ctx.fake.events
  .filter((e) => e.type === 'event:owned-folder-mount-status' && e.payload?.shareId === ctx.share.id)
  .map((e) => e.payload.status)

test('pause records the intent durably, drops the queue and disarms the cadence', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(40) })
  const mounts = ctx.root.mounts
  mounts.schedulePeriodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.ok(armed(ctx), 'precondition: a reconcile timer is armed')

  const r = await mounts.pauseIndex(ctx.spaceId, ctx.share.id)
  t.ok(r.paused)
  t.ok((await getOwnedMount(ctx.spaceId, ctx.share.id)).indexPaused, 'the flag is on the record')
  t.is(getIndexStatus(ctx.spaceId, ctx.share.id).adding, 0, 'the queue is drained')
  t.absent(armed(ctx), 'and the cadence is off — only an explicit resume brings it back')
  t.ok(statuses(ctx).includes('paused'), 'the paused status is announced')
})

test('a paused index declines the scan before it walks', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(20) })
  await ctx.root.mounts.pauseIndex(ctx.spaceId, ctx.share.id)

  const r = await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.is(r.skipped, 'index-paused', 'the pass bails')
  t.alike(await listRelPaths(ctx.share, ctx.spaceId), [], 'and published nothing')
})

// REGRESSION (FIX-PAUSE-1): the scan gate lives in the diff, but onFsEvent enqueues straight onto
// the scheduler on the INTERACTIVE lane and never passes through it. Without the second gate in the
// publish channel's resolve(), a file touched during a pause is published anyway, express-lane,
// past every check the pause installed.
test('REGRESSION (FIX-PAUSE-1): a watcher event during a pause publishes nothing', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'kept.txt': 'a' } })
  await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  await ctx.root.mounts.pauseIndex(ctx.spaceId, ctx.share.id)

  const abs = path.join(ctx.mountPath, 'while-paused.txt')
  fs.writeFileSync(abs, 'b')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'while-paused.txt', abs)

  t.absent((await listRelPaths(ctx.share, ctx.spaceId)).includes('while-paused.txt'),
    'the express lane does not outrank the pause')
})

// REGRESSION (FIX-PAUSE-2): clearing the flag must precede arming the scan. Reversed, the scan
// resume arms is declined by the gate resume has not yet lifted, and Resume silently does nothing —
// the folder stays paused while the UI reports 'scanning'.
test('REGRESSION (FIX-PAUSE-2): resume actually re-enqueues', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(20) })
  const mounts = ctx.root.mounts
  await mounts.pauseIndex(ctx.spaceId, ctx.share.id)

  const r = await mounts.resumeIndex(ctx.spaceId, ctx.share.id)
  t.ok(r.resumed)
  t.absent((await getOwnedMount(ctx.spaceId, ctx.share.id)).indexPaused, 'flag cleared')
  t.ok(armed(ctx), 'the cadence is armed again')
  // The pass resume arms is fire-and-forget; drive one synchronously to assert the effect.
  const scan = await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.absent(scan.skipped, 'the pass runs')
  t.is((await listRelPaths(ctx.share, ctx.spaceId)).length, 20, 'and publishes the folder')
})

test('a file added during a pause is published on resume — a pause loses no changes', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'x' } })
  const mounts = ctx.root.mounts
  await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  await mounts.pauseIndex(ctx.spaceId, ctx.share.id)

  fs.writeFileSync(path.join(ctx.mountPath, 'added-while-paused.txt'), 'y')
  await mounts.resumeIndex(ctx.spaceId, ctx.share.id)
  await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  t.ok((await listRelPaths(ctx.share, ctx.spaceId)).includes('added-while-paused.txt'))
})

test('a file deleted during a pause is retired on resume', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'x', 'gone.txt': 'y' } })
  const mounts = ctx.root.mounts
  await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  await mounts.pauseIndex(ctx.spaceId, ctx.share.id)

  fs.unlinkSync(path.join(ctx.mountPath, 'gone.txt'))
  await mounts.resumeIndex(ctx.spaceId, ctx.share.id)
  await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  t.alike(await listRelPaths(ctx.share, ctx.spaceId), ['a.txt'], 'the resume diff re-derives the retire')
})

// REGRESSION (FIX-PAUSE-3): settleScanStatus maps every non-mount-point-gone { skipped } to durable
// 'paused-error' with the reason as lastError, and WorkerToastBridge raises an error toast for
// exactly that status. Pausing a folder must not look like a failure.
test('REGRESSION (FIX-PAUSE-3): a declined scan settles as paused, never as an error', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(10) })
  const mounts = ctx.root.mounts
  await mounts.pauseIndex(ctx.spaceId, ctx.share.id)

  await mounts.settleScanStatus(
    periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, []), ctx.spaceId, ctx.share.id)

  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'paused')
  t.is(mount.lastError, null, 'and carries no error to render')
  t.absent(statuses(ctx).includes('paused-error'), 'no error status was ever announced')
})

// REGRESSION (FIX-PAUSE-4): cancelShare empties the QUEUE. It does not stop a walkDisk already
// enumerating, and on a large tree that walk is the first minutes of the index — the exact window
// the button gets pressed in. Before the abort signal the walk ran to completion and enqueued
// everything it found, and the pause's only effect was to have each of those items resolved and
// dropped one at a time. The catalog stays clean either way (the publish channel declines them),
// so the WALK is what this asserts: a paused pass must not finish enumerating.
//
// The margin is wide — the walk is hundreds of milliseconds for this many files, the pause is a
// handful of bee ops. If it ever flakes, raise the file count rather than softening the assertion.
test('REGRESSION (FIX-PAUSE-4): a pause mid-walk stops the pass, not just the queue', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(4000) })
  const scan = periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  await ctx.root.mounts.pauseIndex(ctx.spaceId, ctx.share.id)
  const r = await scan

  // totalOnDisk discriminates: both bail shapes report 0, only a completed walk reports the count.
  t.is(r.totalOnDisk, 0, 'the pass bailed instead of enumerating the whole tree')
  t.ok(r.skipped === 'index-paused' || r.cancelled, 'and reported why')
  t.is(getIndexStatus(ctx.spaceId, ctx.share.id).adding, 0, 'nothing was queued behind the pause')
  t.alike(await listRelPaths(ctx.share, ctx.spaceId), [], 'and nothing was published')
})

test('resume does not re-publish what was already published', async (t) => {
  // The property that makes pause worth having: a converged share costs one walk, not a re-index.
  const ctx = await setupOwnedShare(t, { files: manyFiles(20) })
  const mounts = ctx.root.mounts
  await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  await mounts.pauseIndex(ctx.spaceId, ctx.share.id)
  await mounts.resumeIndex(ctx.spaceId, ctx.share.id)
  const r = await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  t.is(r.uploaded, 0, 'a converged share re-publishes nothing across a pause/resume')
  t.is((await listRelPaths(ctx.share, ctx.spaceId)).length, 20, 'and keeps everything it had')
})

// REGRESSION (FIX-PAUSE-5): Pause and Stop are on screen together, so Stop can land in the window
// before Pause's status event re-renders. The cancel-index handler wrote 'active' and armed the
// cadence unconditionally, leaving a healthy badge over a still-gated index and an interval that
// could never do work — the state the boot resume goes out of its way to avoid.
// REGRESSION (FIX-PAUSE-6): setOwnedStatus is the only emitter of event:owned-folder-mount-status,
// and useOwnedMount re-derives ONLY on that event. Skipping the emit when the root was missing left
// the renderer believing the folder was unpaused: the queue drained, the notice vanished, and a
// paused folder was indistinguishable from a finished one.
test('REGRESSION (FIX-PAUSE-6): pausing a folder whose source is gone still tells the UI', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'x' } })
  fs.rmSync(ctx.mountPath, { recursive: true, force: true })

  const before = statuses(ctx).length
  await ctx.root.mounts.pauseIndex(ctx.spaceId, ctx.share.id)

  t.ok((await getOwnedMount(ctx.spaceId, ctx.share.id)).indexPaused, 'the intent is recorded')
  t.ok(statuses(ctx).length > before, 'and an event fired, so the renderer re-reads the mount')
})

// REGRESSION (FIX-PAUSE-7): resume cleared the durable pause before the check that can fail, so a
// resume on an unplugged drive destroyed the intent, flipped the folder to mount-point-gone, and
// returned a result the caller ignored — the user was told nothing.
test('REGRESSION (FIX-PAUSE-7): a resume that cannot run keeps the pause and says so', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'x' } })
  const mounts = ctx.root.mounts
  await mounts.pauseIndex(ctx.spaceId, ctx.share.id)
  fs.rmSync(ctx.mountPath, { recursive: true, force: true })

  await t.exception(() => mounts.resumeIndex(ctx.spaceId, ctx.share.id), 'the caller is told, not left guessing')
  t.ok((await getOwnedMount(ctx.spaceId, ctx.share.id)).indexPaused, 'and the pause survives the failed resume')
})

// REGRESSION (FIX-PAUSE-8): relocate skips its deep pass while the index is paused, and the debt has
// to be RECORDED. Without deep, the resume's fast diff misses on every fresh mtime and
// publishContent re-advertises each entry with a null hash before re-hashing it — the whole-folder
// mirror churn the deep pass exists to avoid.
test('REGRESSION (FIX-PAUSE-8): a deep pass owed from a paused relocate is honoured on resume', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(5) })
  const mounts = ctx.root.mounts
  await mounts.pauseIndex(ctx.spaceId, ctx.share.id)
  // What the relocate handler records when it declines to run its own deep pass.
  await patchOwnedMount(ctx.spaceId, ctx.share.id, { deepScanOwed: true })

  const r = await mounts.resumeIndex(ctx.spaceId, ctx.share.id)
  t.ok(r.deep, 'the resume runs the pass relocate could not')
  t.absent((await getOwnedMount(ctx.spaceId, ctx.share.id)).deepScanOwed, 'and the debt is cleared, so it runs once')

  const again = await mounts.pauseIndex(ctx.spaceId, ctx.share.id)
    .then(() => mounts.resumeIndex(ctx.spaceId, ctx.share.id))
  t.absent(again.deep, 'a later resume is an ordinary pass')
})

// REGRESSION (FIX-PAUSE-9): the post-read re-check consulted only the pause flag, so a Stop landing
// after the walk but during the catalog read (O(catalog), not instant) emptied the queue and was
// then immediately overwritten by enqueueMany — the same "restarts the moment the read lands"
// failure the pause half already fixed.
test('REGRESSION (FIX-PAUSE-9): a cancel mid-read stops the pass too', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(12000) })
  let settled = false
  const scan = periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, []).finally(() => { settled = true })
  // A cancel carries no durable flag, so unlike a pause it bites only once the pass has registered
  // its abort signal — a couple of bee reads in. The real one arrives an IPC round-trip late;
  // retrying stands in for that without guessing a delay that a loaded machine would invalidate.
  while (!settled) {
    cancelIndex(ctx.spaceId, ctx.share.id)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const r = await scan

  t.is(r.totalOnDisk, 0, 'the pass bailed instead of enumerating the whole tree')
  t.ok(r.cancelled, 'and recorded a cancel, not a pause — the cadence picks the folder back up')
  t.absent((await getOwnedMount(ctx.spaceId, ctx.share.id)).indexPaused, 'no pause was recorded')
  t.is(getIndexStatus(ctx.spaceId, ctx.share.id).adding, 0, 'nothing was queued behind it')
})

// REGRESSION (FIX-PAUSE-10): the walk is only half the read. walk-disk checks the signal per file,
// but the catalog read that follows it is O(catalog) and had no check at all, so a Stop landing
// there was overwritten by the enqueueMany that came next. Few files on disk and a large catalog
// puts the whole abort window in that second half, where the per-file check cannot reach.
test('REGRESSION (FIX-PAUSE-10): a cancel during the catalog read stops the pass too', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(3000) })
  await periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  for (const name of fileNames(3000).slice(10)) fs.unlinkSync(path.join(ctx.mountPath, name))

  let settled = false
  const scan = periodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, []).finally(() => { settled = true })
  while (!settled) {
    cancelIndex(ctx.spaceId, ctx.share.id)
    await new Promise((resolve) => setTimeout(resolve, 2))
  }
  const r = await scan

  t.is(r.totalOnDisk, 0, 'the pass bailed in the catalog read, before it could enqueue')
  t.ok(r.cancelled, 'and reported a cancel')
})
