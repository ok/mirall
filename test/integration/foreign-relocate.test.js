import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { relocateForeignFolder, stopForeignLoop, isAutoPaused } from '../../src/shared/folders/foreign-folders.js'
import { initOverlay, teardownOverlay, getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/backends/overlay/index.js'

async function setupMirror (t, { enabled = true, status = null } = {}) {
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
  const origListPeer = overlayBackend.listPeerWithMeta
  overlayBackend.listPeerWithMeta = async () => ({ entries: [], complete: true })
  const overlay = getOverlay()
  const origFetch = overlay.fetchFile
  overlay.fetchFile = async () => null
  const from = ctx.tmpDir('mirror-from')
  const to = ctx.tmpDir('mirror-to')
  await saveForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath: from,
    enabled, status: status ?? (enabled ? 'active' : 'paused'), attachedAt: Date.now(),
    syncedPaths: ['already.bin'], renamedPaths: { 'clash.bin': 'clash (1).bin' },
  })
  t.teardown(async () => {
    stopForeignLoop(spaceId, shareId)
    overlayBackend.listPeerWithMeta = origListPeer
    overlay.fetchFile = origFetch
    await teardownOverlay()
  })
  return { ctx, spaceId, shareId, from, to }
}

test('relocate moves the mount and re-arms it', async (t) => {
  const { spaceId, shareId, from, to } = await setupMirror(t)
  const next = await relocateForeignFolder(spaceId, shareId, to)
  t.is(next.mountPath, to)
  t.is(next.enabled, true, 'relocating is not pausing')
  const stored = await getForeignMount(spaceId, shareId)
  t.is(stored.mountPath, to, 'the record is what survives a restart')
  t.not(stored.mountPath, from)
})

// The synced Set says "this mount already owns these files ON DISK". Carried across a move it
// would claim files exist at a path that has never been written to, and the next pass would skip
// exactly the files it needs to fetch.
test('relocate forgets what the old path owned', async (t) => {
  const { spaceId, shareId, to } = await setupMirror(t)
  const next = await relocateForeignFolder(spaceId, shareId, to)
  t.alike(next.syncedPaths, [], 'nothing is claimed at the new path yet')
  t.alike(next.renamedPaths, {}, 'and no collision workaround is inherited')
  const stored = await getForeignMount(spaceId, shareId)
  t.alike(stored.syncedPaths, [], 'persisted, not just in memory')
})

test('a paused mirror stays paused when it moves', async (t) => {
  const { spaceId, shareId, to } = await setupMirror(t, { enabled: false })
  const next = await relocateForeignFolder(spaceId, shareId, to)
  t.is(next.enabled, false, 'still the user’s pause')
  t.is(next.status, 'paused', 'and it still reads as paused')
})

// Relocating is how a user rescues a mirror whose disk went away, so the one thing it must not do
// is take that mirror out of the set the auto-resume looks at. 'paused' is deliberately NOT an
// auto-pause status, so collapsing into it would strand the mount until the user found Resume.
test('an AUTO-paused mirror keeps the status that makes it auto-resumable', async (t) => {
  for (const status of ['mount-point-gone', 'paused-enospc']) {
    const { spaceId, shareId, to } = await setupMirror(t, { enabled: false, status })
    const next = await relocateForeignFolder(spaceId, shareId, to)
    t.is(next.status, status, status + ' survives the move')
    t.ok(isAutoPaused(next), 'and the mount is still one the boot resume will pick up')
  }
})

test('relocating an unknown mount fails loudly', async (t) => {
  const { spaceId, to } = await setupMirror(t)
  await t.exception(() => relocateForeignFolder(spaceId, 'no-such-share', to), /Mount not found/)
})

// The bytes are not moved by us: whoever moved the folder keeps them, and a fresh destination is
// simply empty. Either way the old path is left exactly as it was.
test('relocate leaves the old directory untouched', async (t) => {
  const { spaceId, shareId, from, to } = await setupMirror(t)
  fs.writeFileSync(path.join(from, 'already.bin'), 'x')
  await relocateForeignFolder(spaceId, shareId, to)
  t.ok(fs.existsSync(path.join(from, 'already.bin')), 'nothing was deleted behind the user')
})
