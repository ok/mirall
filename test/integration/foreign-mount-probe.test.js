import test from 'brittle'
import fs from 'bare-fs'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createForeignMount, getForeignMount } from '../../src/shared/folders/mount-store.js'
import { isAutoPaused } from '../../src/shared/folders/foreign-pause.js'

// The mount-point probe's foreign branch, driven end to end: a mirror whose local target vanishes
// is auto-paused and announced, and its return auto-resumes it. The two verbs it calls have their
// own direct tests; this file pins that the probe reaches them and what it announces afterwards.

const KEY = (shareId) => 'foreign-folder:' + shareId

const statuses = (ctx, shareId) => ctx.fake.events
  .filter((e) => e.type === 'event:foreign-folder-mount-status' && e.payload?.shareId === shareId)
  .map((e) => e.payload.status)

async function plantedMirror(t, { enabled = true, status = 'active', baseline = true } = {}) {
  const ctx = await freshPeer(t)
  const { spaceId } = await createSpace('Aurora')
  const shareId = 'share1'
  const mountPath = ctx.tmpDir('mirror')
  // Self as owner, and no published share: the resume's materialize tick then finds nothing to
  // mirror and cannot unmount, so the probe is the only thing writing the record.
  await createForeignMount({
    spaceId, shareId, ownerKey: getLocalPublicKeyHex(), mountPath,
    enabled, status, attachedAt: Date.now(), syncedPaths: [],
  })
  if (baseline !== null) ctx.root.mounts.lastMountPointStatus.set(KEY(shareId), baseline)
  const read = () => getForeignMount(spaceId, shareId)
  return { ctx, mounts: ctx.root.mounts, shareId, mountPath, read }
}

test('a mirror whose target vanishes is auto-paused and announced', async (t) => {
  const { ctx, mounts, shareId, mountPath, read } = await plantedMirror(t)
  const before = statuses(ctx, shareId).length
  fs.rmSync(mountPath, { recursive: true, force: true })

  await mounts.probeMountPoints()

  const mount = await read()
  t.is(mount.status, 'mount-point-gone', 'the absence is durable')
  t.is(mount.enabled, false, 'and the mirror is disabled')
  t.ok(isAutoPaused(mount), 'as an auto-pause, not a user pause')
  t.is(mounts.lastMountPointStatus.get(KEY(shareId)), false, 'the baseline records the absence')
  t.ok(statuses(ctx, shareId).slice(before).includes('mount-point-gone'), 'and it is announced')
})

test('a second tick over a still-missing target stays silent', async (t) => {
  const { ctx, mounts, shareId, mountPath } = await plantedMirror(t)
  fs.rmSync(mountPath, { recursive: true, force: true })
  await mounts.probeMountPoints()
  const before = statuses(ctx, shareId).length

  await mounts.probeMountPoints()

  t.is(statuses(ctx, shareId).length, before, 'gone→gone is not a transition')
})

test('a returning target auto-resumes the mirror and announces its real status', async (t) => {
  const { ctx, mounts, shareId, mountPath, read } = await plantedMirror(t)
  fs.rmSync(mountPath, { recursive: true, force: true })
  await mounts.probeMountPoints()
  t.is((await read()).status, 'mount-point-gone', 'precondition: paused on the gone edge')
  const before = statuses(ctx, shareId).length

  fs.mkdirSync(mountPath, { recursive: true })
  await mounts.probeMountPoints()

  const mount = await read()
  t.is(mount.enabled, true, 'the mirror is re-enabled')
  t.is(mount.status, 'active')
  t.is(mounts.lastMountPointStatus.get(KEY(shareId)), true, 'the baseline follows the disk')
  const emitted = statuses(ctx, shareId).slice(before)
  t.is(emitted.at(-1), 'active', 'the probe announces the record after the resume, not the edge')
})

// The record can say gone over a path that is back without this probe having seen the departure:
// a pause written by an ENOENT on the poll loop, or a departure and return inside one restart.
test('a record that disagrees with the disk is a transition, whatever the baseline says', async (t) => {
  const { ctx, mounts, shareId, read } = await plantedMirror(t, {
    enabled: false, status: 'mount-point-gone', baseline: true,
  })
  const before = statuses(ctx, shareId).length

  await mounts.probeMountPoints()

  const mount = await read()
  t.is(mount.enabled, true, 'resumed')
  t.is(mount.status, 'active')
  t.ok(statuses(ctx, shareId).length > before, 'and announced')
})

test('a user pause survives its target leaving and coming back', async (t) => {
  const { ctx, mounts, shareId, mountPath, read } = await plantedMirror(t, { enabled: false, status: 'paused' })
  fs.rmSync(mountPath, { recursive: true, force: true })

  await mounts.probeMountPoints()
  t.is((await read()).status, 'paused', 'the record keeps the pause the user set')
  t.is(statuses(ctx, shareId).at(-1), 'mount-point-gone', 'while the live event says the path is gone')

  fs.mkdirSync(mountPath, { recursive: true })
  await mounts.probeMountPoints()
  const mount = await read()
  t.is(mount.status, 'paused', 'a returning path is not the user pressing Resume')
  t.is(mount.enabled, false)
  t.is(statuses(ctx, shareId).at(-1), 'paused', 'and the event says so')
})

test('a probe tick over an unchanged, healthy mirror stays silent', async (t) => {
  const { ctx, mounts, shareId } = await plantedMirror(t)
  await mounts.probeMountPoints()
  const before = statuses(ctx, shareId).length

  await mounts.probeMountPoints()
  await mounts.probeMountPoints()

  t.is(statuses(ctx, shareId).length, before, 'two further ticks emit nothing')
})
