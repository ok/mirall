import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { getOwnedMount, patchOwnedMount } from '../../src/shared/folders/mount-store.js'
import { initialPublishScan } from '../../src/shared/folders/owned-folders.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'
import { ErrorCodes } from '../../src/shared/core/errors.js'

// How an owned folder's local I/O faults reach its durable status. The mirror side classified its
// faults from the start; the owner collapsed everything to 'paused-error' with a raw errno message
// — and its most common faults never reached that branch at all, because a publish that fails is
// counted per item and the pass still resolves.

const errno = (code, message) => Object.assign(new Error(message), { code })

const statuses = (ctx) => ctx.fake.events
  .filter((e) => e.type === 'event:owned-folder-mount-status' && e.payload?.shareId === ctx.share.id)
  .map((e) => e.payload)

const failPublishWith = (t, err) => {
  const orig = overlayBackend.publishAdd
  overlayBackend.publishAdd = async () => { throw err }
  t.teardown(() => { overlayBackend.publishAdd = orig })
}

test('REGRESSION (FIX-PI12-1: a pass whose publishes all failed on a full disk records paused-enospc, not active)', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'aa', 'b.txt': 'bb' } })
  failPublishWith(t, errno('ENOSPC', "ENOSPC: no space left on device, write '/tmp/x'"))

  const result = await ctx.root.mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  t.ok(result.failed > 0, 'precondition: the pass really did fail its items')

  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'paused-enospc', 'the fault the scheduler counted and dropped now settles the status')
  t.is(mount.lastError, ErrorCodes.TRANSFER_DISK_FULL, 'and it is a code the renderer translates')
})

test('REGRESSION (FIX-PI12-1: a permission fault on the publish path is classified too)', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'aa' } })
  failPublishWith(t, errno('EACCES', "EACCES: permission denied, open '/tmp/a.txt'"))

  await ctx.root.mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'paused-error', 'a permission fault has no status of its own — the reason carries it')
  t.is(mount.lastError, ErrorCodes.TRANSFER_PERMISSION)
})

test('an unclassified publish failure is not a mount fault', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'aa' } })
  failPublishWith(t, new Error('something transient'))

  await ctx.root.mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'active', 'pausing a folder on an error nobody can act on would be worse than the log line')
})

// The stubs above prove the wiring; this proves the PREMISE. A file the app genuinely cannot read
// is the fault this feature exists for, and nothing else in the suite drives the real publish path
// with one — which is how a UI scenario built on an impossible lever got as far as being run.
test('a genuinely unreadable file faults the mount through the real publish path', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'aa' } })
  const sealed = path.join(ctx.mountPath, 'sealed.txt')
  fs.writeFileSync(sealed, 'cannot read this')
  fs.chmodSync(sealed, 0o000)
  t.teardown(() => { try { fs.chmodSync(sealed, 0o644) } catch {} })

  const result = await ctx.root.mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  t.is(result.uploaded, 1, 'the readable file still published — one bad file is not a bad folder')
  t.is(result.failed, 1)

  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'paused-error')
  t.is(mount.lastError, ErrorCodes.TRANSFER_PERMISSION, 'classified from the real errno, not a double')
})

test('REGRESSION (FIX-PI12-2: a classified whole-pass failure records the code, never err.message)', async (t) => {
  const ctx = await setupOwnedShare(t)
  const err = errno('ENOSPC', "ENOSPC: no space left on device, write '/Users/someone/Docs/x.tmp'")

  await ctx.root.mounts.settleScanStatus(Promise.reject(err), ctx.spaceId, ctx.share.id)

  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'paused-enospc')
  t.is(mount.lastError, ErrorCodes.TRANSFER_DISK_FULL, 'the errno string went to the log, not to the record')
  t.absent(statuses(ctx).some((p) => (p.error ?? '').includes('no space left')), 'and not onto the wire either')
})

test('an unclassified whole-pass failure keeps its message (the fallback is intact)', async (t) => {
  const ctx = await setupOwnedShare(t)

  await ctx.root.mounts.settleScanStatus(Promise.reject(new Error('Share missing for mount')), ctx.spaceId, ctx.share.id)

  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'paused-error')
  t.is(mount.lastError, 'Share missing for mount', 'an unrecognised error with nothing to say is worse than a raw one')
})

test('a root that vanished mid-pass settles as mount-point-gone, not as a fault', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'aa' } })
  fs.rmSync(ctx.mountPath, { recursive: true, force: true })

  await ctx.root.mounts.settleScanStatus(
    Promise.reject(errno('ENOENT', "ENOENT: no such file or directory, scandir '" + ctx.mountPath + "'")),
    ctx.spaceId, ctx.share.id,
  )
  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'mount-point-gone', 'a missing root is ambiguous, and its own status already says so')
  t.is(ctx.root.mounts.lastMountPointStatus.get('owned-folder:' + ctx.share.id), false,
    'the absence is recorded, so the probe reads the RETURN as an edge')
})

// settleScanStatus documents four outcomes it must keep apart, and this change edits both its
// catch and its success path. These are the guard on the distinctions, not on the new behaviour.
test("a cancelled pass still records nothing", async (t) => {
  const ctx = await setupOwnedShare(t)
  await patchOwnedMount(ctx.spaceId, ctx.share.id, { status: 'scanning' })

  await ctx.root.mounts.settleScanStatus(Promise.resolve({ cancelled: true, failed: 0 }), ctx.spaceId, ctx.share.id)

  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'scanning',
    'whoever cancelled it owns the status from here')
})

test('an index-paused skip still records paused, not a fault', async (t) => {
  const ctx = await setupOwnedShare(t)

  await ctx.root.mounts.settleScanStatus(Promise.resolve({ skipped: 'index-paused' }), ctx.spaceId, ctx.share.id)

  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'paused', 'a decision is not a fault')
})

test('a skip with any other reason still records paused-error carrying it', async (t) => {
  const ctx = await setupOwnedShare(t)

  await ctx.root.mounts.settleScanStatus(Promise.resolve({ skipped: 'unsupported-content-mode' }), ctx.spaceId, ctx.share.id)

  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'paused-error')
  t.is(mount.lastError, 'unsupported-content-mode')
})

// CHARACTERISATION of what already recovers an owned fault, recorded because the fix rests on it:
// there is no probe-driven recovery for a fault whose path never went away, and none is added. The
// next pass to settle is what clears the status, and the cadence that runs those passes survives a
// fault untouched.
test('a faulted owned folder returns to active on the next clean pass, with its cadence still armed', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'aa' } })
  const mounts = ctx.root.mounts
  mounts.schedulePeriodicReconcile(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  await mounts.settleScanStatus(Promise.reject(errno('ENOSPC', 'full')), ctx.spaceId, ctx.share.id)
  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'paused-enospc', 'precondition: faulted')
  t.ok(mounts.periodicTimers.has(ctx.spaceId + ':' + ctx.share.id),
    'a fault does not disarm the cadence — that is what retries it')

  await mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  const mount = await getOwnedMount(ctx.spaceId, ctx.share.id)
  t.is(mount.status, 'active', 'the pass that succeeds is the recovery')
  t.is(mount.lastError, null, 'and it clears the reason with it')
})

test('REGRESSION (FIX-PI12-3: a pass that declined to run does not consume the pending fault)', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'aa' } })
  failPublishWith(t, errno('ENOSPC', 'full'))
  fs.writeFileSync(path.join(ctx.mountPath, 'c.txt'), 'cc')
  const { onFsEvent } = await import('../../src/shared/folders/owned-folders.js')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'c.txt', path.join(ctx.mountPath, 'c.txt'))

  // A pause declines the next pass before it walks. The fault it would have reported was observed
  // by the watcher item above and is still unreported, so it must survive rather than die with the
  // pass that never ran.
  await patchOwnedMount(ctx.spaceId, ctx.share.id, { indexPaused: true })
  await ctx.root.mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'paused', 'precondition: the pass declined')

  await patchOwnedMount(ctx.spaceId, ctx.share.id, { indexPaused: false })
  await ctx.root.mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'paused-enospc',
    'the pass that actually settles is the one that reports it')
})

test('a fault recorded by a watcher item between passes is not lost', async (t) => {
  const ctx = await setupOwnedShare(t, { files: { 'a.txt': 'aa' } })
  await ctx.root.mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'active', 'precondition: healthy')

  // The live case: a file dropped in while the disk is full fails on the interactive lane, and the
  // catch-up pass that follows it is the one that settles the status.
  failPublishWith(t, errno('ENOSPC', 'full'))
  fs.writeFileSync(path.join(ctx.mountPath, 'c.txt'), 'cc')
  const { onFsEvent } = await import('../../src/shared/folders/owned-folders.js')
  await onFsEvent(ctx.spaceId, ctx.share.id, 'add', 'c.txt', path.join(ctx.mountPath, 'c.txt'))

  await ctx.root.mounts.settleScanStatus(
    initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, []),
    ctx.spaceId, ctx.share.id,
  )
  t.is((await getOwnedMount(ctx.spaceId, ctx.share.id)).status, 'paused-enospc',
    'the fault carries to the pass that settles next, rather than being cleared when it starts')
})
