import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { scanForeignMount, setForeignEnabled } from '../../src/shared/folders/foreign-verbs.js'
import { runMaterializeTick } from '../../src/shared/folders/mirror-pass.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/overlay/index.js'
import { CODES } from '../../src/shared/contract/errors.js'
import fs from 'bare-fs'
import { capture } from '../helpers/capture-console.js'
import { setVerbose } from '../helpers/runtime-verbose.js'

// REGRESSION (FIX-129): a disk-write failure during an overlay mirror fetch must
// pause the mount with a surfaced status — same classification as the eager path —
// instead of being logged as a generic give-up that retries every poll tick.
// Network-free: the overlay's fetchFile is stubbed to throw the fs error code that
// (post-fix) now propagates out of the real fetch.

// The honest test of a read-only folder: whether a write into it is refused.
function writable(dir) {
  try {
    fs.writeFileSync(dir + '/.probe', 'x')
    fs.unlinkSync(dir + '/.probe')
    return true
  } catch (err) {
    return !['EACCES', 'EPERM', 'EROFS'].includes(err.code)
  }
}

function statuses(ctx, shareId) {
  return ctx.fake.events
    .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
    .map((e) => e.payload.status)
}

function faultEvents(ctx, shareId) {
  return ctx.fake.events
    .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
    .map((e) => e.payload)
}

async function setupOverlayMirror(t, code) {
  const ctx = await freshPeer(t)
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })

  const space = await createSpace('Aurora')
  const spaceId = space.spaceId
  const shareId = generateShareId()
  await publishShare(spaceId, {
    id: shareId, type: 'owned-folder', name: 'Mirror', owner: getLocalPublicKeyHex(),
    contentMode: 'overlay', catalogKey: 'c'.repeat(64), createdAt: Date.now(),
  })

  const origListPeer = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => ({ entries: [{ relPath: 'big.bin', contentHash: 'a'.repeat(64), size: 1024 }], complete: true })
  t.teardown(() => { overlayBackend.listPeerWithMeta = origListPeer })

  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  t.teardown(() => { overlay.fetchFile = origFetch })
  overlay.fetchFile = async () => { const e = new Error('disk error'); e.code = code; throw e }

  const mountPath = ctx.tmpDir('mirror')
  await createForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath,
    enabled: true, attachedAt: Date.now(), status: 'active', syncedPaths: [],
  })
  return { ctx, spaceId, shareId, mountPath }
}

test('REGRESSION (FIX-129): an ENOSPC overlay-mirror fetch pauses the mount (paused-enospc)', async (t) => {
  const { ctx, spaceId, shareId } = await setupOverlayMirror(t, 'ENOSPC')
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-enospc', 'mount paused with the enospc status')
  t.absent(mount.enabled, 'mount disabled')
  t.ok(statuses(ctx, shareId).includes('paused-enospc'), 'paused-enospc status surfaced')
})

// The collision sibling is claimed when the owner's bytes land there. A pass paused by a disk fault
// before that must persist no mapping, or the record points the owner's key at a name that holds
// nothing of ours — and a later delete of that key would reach whatever the user puts there.
test('REGRESSION (MIR-50): a pause before the sibling landed persists no mapping', async (t) => {
  const { spaceId, shareId, mountPath } = await setupOverlayMirror(t, 'ENOSPC')
  // The user's own file at the natural name, so the pass has to pick a sibling before it fetches.
  fs.writeFileSync(mountPath + '/big.bin', 'the users own file')

  await runMaterializeTick(spaceId, shareId)

  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-enospc', 'the pass paused on the disk fault')
  t.absent(mount.renamedPaths?.['big.bin'], 'no sibling is mapped for bytes that never landed')
  t.absent(mount.syncedPaths?.includes('big.bin'), 'nor is the key owned')
  t.is(fs.readFileSync(mountPath + '/big.bin', 'utf8'), 'the users own file', 'the user file is untouched')
})

// A folder that really refuses writes: the permission errno is believed only once a probe of the
// folder agrees, so the folder is made read-only rather than the errno merely thrown. Where the
// mode bits do not refuse a write (Windows, a root run) there is nothing to assert.
test('REGRESSION (FIX-129): an EACCES overlay-mirror fetch into a read-only folder pauses the mount (paused-error)', async (t) => {
  const { spaceId, shareId, mountPath } = await setupOverlayMirror(t, 'EACCES')
  fs.chmodSync(mountPath, 0o500)
  t.teardown(() => { try { fs.chmodSync(mountPath, 0o700) } catch {} }, { order: -1 })
  if (writable(mountPath)) { t.comment('the mode bits do not refuse a write here'); t.pass('skipped'); return }
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-error', 'mount paused with the generic error status')
  t.absent(mount.enabled, 'mount disabled')
})

// REGRESSION (FIX-663: the mirror paused the whole mount on a permission errno alone, so one file
// another program held for a moment stopped a folder that takes writes fine.)
test('REGRESSION (FIX-663): a permission errno into a writable folder retries the file instead of pausing', async (t) => {
  const { spaceId, shareId, mountPath } = await setupOverlayMirror(t, 'EACCES')
  const overlay = getOverlay()
  const refuse = overlay.fetchFile
  let calls = 0
  overlay.fetchFile = async (hash, opts) => {
    if (++calls === 1) return await refuse(hash, opts)
    fs.writeFileSync(opts.destPath, 'ok')
    return { destPath: opts.destPath }
  }

  await runMaterializeTick(spaceId, shareId)
  const after = await getForeignMount(spaceId, shareId)
  t.is(calls, 1, 'precondition: the first fetch was refused')
  t.ok(after.enabled, 'the mount stays active')
  t.absent(after.lastError, 'and records no permission fault')

  await runMaterializeTick(spaceId, shareId)
  t.is(calls, 2, 'the next tick asks for the file again')
  t.ok(fs.existsSync(mountPath + '/big.bin'), 'and it lands')
})

// A pause carries a REASON the renderer can translate. It used to carry err.message, which reached
// the user as "ENOSPC: no space left on device, write '/Users/…'" in every language.
test('a pause records the error code, never the errno message', async (t) => {
  const { spaceId, shareId } = await setupOverlayMirror(t, 'ENOSPC')
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.lastError, CODES.TRANSFER_DISK_FULL, 'durable, so the folder screen survives a reload')
})

// The mount-time scan is the one producer that is not a pause: its loop still starts, so it must
// record the fault WITHOUT disabling the mount, and it must not put a raw message on a wire field
// the renderer reads as a code.
test('a failed initial scan records the fault without pausing the mount', async (t) => {
  const { ctx, spaceId, shareId } = await setupOverlayMirror(t, 'EACCES')
  const err = Object.assign(new Error("EACCES: permission denied, open '/Volumes/ext/x'"), { code: 'EACCES' })
  const list = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => { throw err }
  t.teardown(() => { overlayBackend.listPeerWithMeta = list }, { order: -1 })

  t.is(await scanForeignMount(await getForeignMount(spaceId, shareId)), 'faulted')

  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-error', 'durable — a reload used to show a mirror still "scanning"')
  t.is(mount.lastError, CODES.TRANSFER_PERMISSION)
  t.ok(mount.enabled, 'the poll loop still runs, so this is not an auto-pause')
  const last = faultEvents(ctx, shareId).at(-1)
  t.is(last.error, CODES.TRANSFER_PERMISSION, 'the wire carries the code the renderer translates')
})

test('a successful pass clears the reason with the status', async (t) => {
  const { spaceId, shareId } = await setupOverlayMirror(t, 'ENOSPC')
  await runMaterializeTick(spaceId, shareId)
  t.is((await getForeignMount(spaceId, shareId)).lastError, CODES.TRANSFER_DISK_FULL, 'precondition')

  const overlay = getOverlay()
  overlay.fetchFile = async (hash, { destPath } = {}) => { fs.writeFileSync(destPath, 'ok'); return { destPath } }
  await setForeignEnabled(spaceId, shareId, true)
  await runMaterializeTick(spaceId, shareId)

  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'active')
  t.is(mount.lastError, null, 'a stale reason would name the next fault that records none')
})

// The diag's own lines for the one entry, minus its opening ones: what is left is how it closed.
// The diag exposes no readable state, so its log lines are the artifact.
function diagEnds(lines) {
  return [...lines.log, ...lines.warn]
    .filter((l) => l.startsWith('[overlay-fetch]') && l.includes('big.bin'))
    .filter((l) => !/ start: | scheduler end: /.test(l))
}

// REGRESSION (FIX-660: a rejection that paused the mount returned before closing the fetch's diag,
// so its `start:` line was the only one in the log with no terminal line after it.)
test('REGRESSION (FIX-660): a rejection that pauses the mount closes its fetch diag as paused', async (t) => {
  const { spaceId, shareId } = await setupOverlayMirror(t, 'ENOSPC')
  setVerbose(t, true)
  const lines = capture(t, ['log', 'warn'])

  await runMaterializeTick(spaceId, shareId)

  t.is((await getForeignMount(spaceId, shareId)).status, 'paused-enospc', 'precondition: the rejection paused the mount')
  const ends = diagEnds(lines)
  t.is(ends.length, 1, 'the diag is settled once')
  t.ok(ends[0]?.includes('overlay mirror paused:'), 'as a deliberate stop: ' + ends[0])
})
