import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createOwnedMount, getOwnedMount } from '../../src/shared/folders/mount-store.js'

async function plantedMount (t, { makePath }) {
  const ctx = await freshPeer(t)
  const mountPath = path.join(ctx.tmpDir('owned'), 'Docs')
  makePath(mountPath)
  const mount = { spaceId: 'space1', shareId: 'share1', mountPath, ignore: [], createdAt: Date.now() }
  await createOwnedMount(mount)
  // The probe reports a TRANSITION, so it needs a baseline saying the path was there.
  ctx.root.mounts.lastMountPointStatus.set('owned-folder:' + mount.shareId, true)
  return { ctx, mount }
}

// REGRESSION (FIX-MOUNTPROBE-1: the 60 s probe asked statSync whether ANYTHING existed at the
// mount path while every resume pass asks mountRootAvailable whether a DIRECTORY does. A path
// replaced by a file read present to the probe and absent to the resume, so the folder kept a
// durable 'active' status that nothing could publish into.)
test('REGRESSION (FIX-MOUNTPROBE-1): a mount path replaced by a file reads as gone', async (t) => {
  const { ctx, mount } = await plantedMount(t, {
    makePath: (p) => fs.writeFileSync(p, 'not a directory'),
  })

  await ctx.root.mounts.probeMountPoints()

  const read = await getOwnedMount(mount.spaceId, mount.shareId)
  t.is(read.status, 'mount-point-gone', 'the probe agrees with the resume passes')
  t.is(ctx.root.mounts.lastMountPointStatus.get('owned-folder:' + mount.shareId), false,
    'and the probe baseline records the absence')
})

test('a mount path that is still a directory is left alone', async (t) => {
  const { ctx, mount } = await plantedMount(t, {
    makePath: (p) => fs.mkdirSync(p, { recursive: true }),
  })

  await ctx.root.mounts.probeMountPoints()

  const read = await getOwnedMount(mount.spaceId, mount.shareId)
  t.not(read.status, 'mount-point-gone', 'a healthy mount is not torn down by the probe')
  t.is(ctx.root.mounts.lastMountPointStatus.get('owned-folder:' + mount.shareId), true)
})
