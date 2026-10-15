import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import {
  createOwnedMount, deleteOwnedMount, patchOwnedMount, createForeignMount, insertForeignMount,
  mutateForeignMount, deleteForeignMount, setMountRootsListener,
} from '../../src/shared/folders/mount-store.js'
import { listRevealRoots } from '../../src/shared/folders/reveal-roots.js'
import { listDownloadRoots } from '../../src/shared/core/paths.js'

// Main authorizes a reveal against roots the worker pushes. A mount is a root the moment it exists,
// and stops being one the moment it is gone or moved — so the store says when, and says it only
// then: the mirror pass patches a record per synced file, and a push per patch would be a scan per
// file.

const owned = (mountPath) => ({ spaceId: 's1', shareId: 'sh1', mountPath, ignore: [], enabled: true, status: 'scanning' })
const foreign = (shareId, mountPath) => ({ spaceId: 's1', shareId, mountPath, enabled: true, status: 'scanning', syncedPaths: [], renamedPaths: {} })

function arm(t) {
  let fired = 0
  setMountRootsListener(() => { fired++ })
  t.teardown(() => setMountRootsListener(() => {}))
  return () => fired
}

test('a mount create and delete each announce a roots change', async (t) => {
  await freshPeer(t)
  const fired = arm(t)
  await createOwnedMount(owned('/Volumes/Data/a'))
  t.is(fired(), 1)
  await deleteOwnedMount('s1', 'sh1')
  t.is(fired(), 2)
  await createForeignMount(foreign('sh2', '/Volumes/Data/m'))
  t.is(fired(), 3)
  await deleteForeignMount('s1', 'sh2')
  t.is(fired(), 4)
})

test('a fresh insert announces; an insert that found a record does not', async (t) => {
  await freshPeer(t)
  const fired = arm(t)
  t.is(await insertForeignMount(foreign('sh2', '/Volumes/Data/m')), null)
  t.is(fired(), 1)
  t.ok(await insertForeignMount(foreign('sh2', '/Volumes/Data/other')), 'the existing record is answered')
  t.is(fired(), 1, 'and nothing moved')
})

test('a relocate announces; a bookkeeping patch does not', async (t) => {
  await freshPeer(t)
  await createOwnedMount(owned('/Volumes/Data/a'))
  const fired = arm(t)
  await patchOwnedMount('s1', 'sh1', { lastScanCompletedAt: 1 })
  t.is(fired(), 0, 'a scan stamp moves no root')
  await patchOwnedMount('s1', 'sh1', { mountPath: '/Volumes/Data/a' })
  t.is(fired(), 0, 'nor does the same path written again')
  await patchOwnedMount('s1', 'sh1', { mountPath: '/Volumes/Data/b' })
  t.is(fired(), 1)
  await patchOwnedMount('s1', 'gone', { mountPath: '/Volumes/Data/c' })
  t.is(fired(), 1, 'a patch to a record that is not there moves nothing')
})

test('a mirror pass patch does not announce; a mirror relocate does', async (t) => {
  await freshPeer(t)
  await createForeignMount(foreign('sh2', '/Volumes/Data/m'))
  const fired = arm(t)
  await mutateForeignMount('s1', 'sh2', (m) => ({ ...m, syncedPaths: ['/x'] }))
  t.is(fired(), 0)
  await mutateForeignMount('s1', 'sh2', (m) => ({ ...m, mountPath: '/Volumes/Data/n' }))
  t.is(fired(), 1)
  await mutateForeignMount('s1', 'sh2', () => null)
  t.is(fired(), 1, 'a declined mutate moves nothing')
})

test('the reveal roots are the download roots plus every mount path, once each', async (t) => {
  await freshPeer(t)
  await createOwnedMount(owned('/Volumes/Data/a'))
  await createForeignMount(foreign('sh2', '/Volumes/Data/a'))
  await createForeignMount(foreign('sh3', '/Volumes/Data/m'))
  const roots = await listRevealRoots()
  t.is(roots.filter((r) => r === '/Volumes/Data/a').length, 1, 'deduplicated')
  t.ok(roots.includes('/Volumes/Data/m'))
  for (const r of listDownloadRoots()) t.ok(roots.includes(r), 'download roots still in: ' + r)
})
