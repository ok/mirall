import test from 'brittle'
import fs from 'bare-fs'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  isAutoPaused, resumeAutoPausedForeignMount, autoPauseForeignMountGone, runMaterializeTick, stopForeignLoop,
} from '../../src/shared/folders/foreign-folders.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

function statuses (ctx, shareId) {
  return ctx.fake.events
    .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
    .map((e) => e.payload.status)
}

async function setupMirror (t, { fetchImpl } = {}) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true })
  await initOverlay()
  const space = await createSpace('Aurora')
  const spaceId = space.spaceId
  const shareId = generateShareId()
  await publishShare(spaceId, {
    id: shareId, type: 'owned-folder', name: 'Mirror', owner: getLocalPublicKeyHex(),
    contentMode: 'overlay', catalogKey: 'c'.repeat(64), createdAt: Date.now(),
  })
  const origListPeer = overlayBackend.listPeer
  overlayBackend.listPeer = async () => [{ relPath: 'big.bin', contentHash: 'a'.repeat(64), size: 1024 }]
  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  overlay.fetchFile = fetchImpl || (async () => null)
  const mountPath = ctx.tmpDir('mirror')
  t.teardown(async () => {
    stopForeignLoop(spaceId, shareId)
    overlayBackend.listPeer = origListPeer
    overlay.fetchFile = origFetch
    await teardownOverlay()
  })
  return { ctx, spaceId, shareId, mountPath }
}

async function planted (spaceId, shareId, mountPath, status) {
  await saveForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath,
    enabled: false, status, attachedAt: Date.now(), syncedPaths: [],
  })
}

test('isAutoPaused distinguishes auto pauses from a user pause', (t) => {
  const base = { enabled: false }
  for (const s of ['mount-point-gone', 'paused-enospc', 'paused-error']) {
    t.ok(isAutoPaused({ ...base, status: s }), `${s} is auto-paused`)
  }
  t.absent(isAutoPaused({ ...base, status: 'paused' }), 'a user pause is NOT auto-paused')
  t.absent(isAutoPaused({ enabled: true, status: 'active' }), 'an enabled mount is not paused')
  t.absent(isAutoPaused(null), 'null is safe')
})

// REGRESSION (G2): a mount auto-paused for a vanished mount point resumes once the
// path is back — the exact case the boot loop + probe skipped before.
test('REGRESSION (G2): resume re-enables a mount-point-gone mirror whose path returned', async (t) => {
  const { ctx, spaceId, shareId, mountPath } = await setupMirror(t)
  await planted(spaceId, shareId, mountPath, 'mount-point-gone')

  const resumed = await resumeAutoPausedForeignMount(spaceId, shareId)

  t.ok(resumed, 'resume reported success')
  const mount = await getForeignMount(spaceId, shareId)
  t.ok(mount.enabled, 're-enabled')
  t.is(mount.status, 'active', 'status back to active')
  t.ok(statuses(ctx, shareId).includes('active'), 'active status surfaced to the renderer')
})

// REGRESSION (G2): the same for an enospc/perm pause once the fault clears (the
// common free-space-then-relaunch recovery).
test('REGRESSION (G2): resume re-enables an enospc-paused mirror', async (t) => {
  const { spaceId, shareId, mountPath } = await setupMirror(t)
  await planted(spaceId, shareId, mountPath, 'paused-enospc')
  t.ok(await resumeAutoPausedForeignMount(spaceId, shareId), 'resumed')
  t.ok((await getForeignMount(spaceId, shareId)).enabled, 're-enabled')
})

// Guard: a USER pause is never auto-resumed.
test('G2: a user-paused mount is not resumed', async (t) => {
  const { spaceId, shareId, mountPath } = await setupMirror(t)
  await planted(spaceId, shareId, mountPath, 'paused')
  t.absent(await resumeAutoPausedForeignMount(spaceId, shareId), 'not resumed')
  t.absent((await getForeignMount(spaceId, shareId)).enabled, 'stays disabled')
})

// Guard: an auto-paused mount whose path is STILL missing is not resumed (nothing to do).
test('G2: a still-missing mount point is not resumed', async (t) => {
  const { spaceId, shareId, ctx } = await setupMirror(t)
  const gonePath = ctx.tmpDir('mirror-gone')
  fs.rmSync(gonePath, { recursive: true, force: true })
  await planted(spaceId, shareId, gonePath, 'mount-point-gone')
  t.absent(await resumeAutoPausedForeignMount(spaceId, shareId), 'not resumed while path missing')
})

// REGRESSION (G2 self-correction): resuming a mount whose fault persists (fetch still throws
// ENOSPC) must re-pause it AND leave it resumable. The bug: the initial scan's trailing
// status:'active' clobbered the mid-scan pause, persisting enabled=false + status='active'
// (no longer isAutoPaused) — permanently locking the mount out of future auto-resume.
test('REGRESSION (G2): a resumed-but-still-faulted mount re-pauses and stays resumable', async (t) => {
  const { spaceId, shareId, mountPath } = await setupMirror(t, {
    fetchImpl: async () => { const e = new Error('disk full'); e.code = 'ENOSPC'; throw e },
  })
  await planted(spaceId, shareId, mountPath, 'paused-enospc')
  await resumeAutoPausedForeignMount(spaceId, shareId)
  await runMaterializeTick(spaceId, shareId)
  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'paused-enospc', 're-paused with the real status (NOT clobbered to active)')
  t.absent(mount.enabled, 'disabled again')
  t.ok(isAutoPaused(mount), 'still auto-paused → resumable again, not locked into enabled=false/status=active')
})

// An idle mirror whose local path vanished got only transient probe events: no write ever
// hit the missing destination, so no I/O error classified the fault and the durable status
// stayed 'active' — a refresh or boot then resurrected a healthy badge for a dead mount.
test('REGRESSION (FIX-G3: a vanished path durably auto-pauses an idle mirror)', async (t) => {
  const { ctx, spaceId, shareId, mountPath } = await setupMirror(t)
  fs.mkdirSync(mountPath, { recursive: true })
  await saveForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath,
    enabled: true, status: 'active', attachedAt: Date.now(), syncedPaths: [],
  })

  fs.rmSync(mountPath, { recursive: true, force: true })
  t.ok(await autoPauseForeignMountGone(spaceId, shareId), 'gone path pauses the mirror')

  const mount = await getForeignMount(spaceId, shareId)
  t.is(mount.status, 'mount-point-gone', 'the pause is durable, not event-only')
  t.is(mount.enabled, false, 'the poll loop is disabled with it')
  t.ok(isAutoPaused(mount), 'classified as the recoverable auto-pause kind')
  t.ok(statuses(ctx, shareId).includes('mount-point-gone'), 'the transition still announces live')

  t.absent(await autoPauseForeignMountGone(spaceId, shareId), 'already paused → no-op')

  fs.mkdirSync(mountPath, { recursive: true })
  await saveForeignMount({ ...mount, enabled: false, status: 'paused' })
  t.absent(await autoPauseForeignMountGone(spaceId, shareId), 'a user pause is never touched')

  await saveForeignMount({ ...mount, enabled: true, status: 'active' })
  t.absent(await autoPauseForeignMountGone(spaceId, shareId), 'a present path is never paused')
})
