import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer, rebootPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { markDownloaded, markVerified } from '../../src/shared/transfer/files.js'
import {
  createOwnedMount, deleteOwnedMount, patchOwnedMount, createForeignMount, insertForeignMount,
  mutateForeignMount, deleteForeignMount, setMountRootsListener,
} from '../../src/shared/folders/mount-store.js'
import { listRevealRoots } from '../../src/shared/folders/reveal-roots.js'
import { listDownloadRoots, noteLandedFolders, setRecentDownloadFolders, setSpaceDownloadRoot } from '../../src/shared/core/paths.js'

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

test('the reveal roots are every download root plus every mount path, once each', async (t) => {
  await freshPeer(t)
  setSpaceDownloadRoot('s1', '/Volumes/Data/current')
  setRecentDownloadFolders(['/Volumes/Data/recent', '/Volumes/Data/a'])
  noteLandedFolders(['/Volumes/Data/landed'])
  await createOwnedMount(owned('/Volumes/Data/a'))
  await createForeignMount(foreign('sh2', '/Volumes/Data/a'))
  await createForeignMount(foreign('sh3', '/Volumes/Data/m'))
  const roots = await listRevealRoots()
  t.is(roots.filter((r) => r === '/Volumes/Data/a').length, 1, 'deduplicated')
  t.ok(roots.includes('/Volumes/Data/m'))
  for (const r of ['/Volumes/Data/current', '/Volumes/Data/recent', '/Volumes/Data/landed']) t.ok(roots.includes(r), 'a current, offered and landed folder: ' + r)
  for (const r of listDownloadRoots()) t.ok(roots.includes(r), 'download roots still in: ' + r)
})

// REGRESSION (FIX-DLTO-R8: a claim from before claims named their folder joined no download root, so
// a copy left in a folder no space downloads into any more read Downloaded "In …" while Reveal was
// refused; and the boot found the folders by reading every record of the downloads bee.)
test('REGRESSION (FIX-DLTO-R8: a legacy copy\'s folder is a reveal root after boot)', async (t) => {
  const peer = await freshPeer(t)
  const space = await createSpace('Nord')
  const oldFolder = peer.tmpDir('old-override')
  const legacy = path.join(oldFolder, 'x.txt')
  fs.writeFileSync(legacy, 'bytes')
  await markDownloaded(space.spaceId, '/Docs/x.txt', legacy, { hash: 'h1' })
  const verifiedOnly = peer.tmpDir('verified-only')
  await markVerified(space.spaceId, 'sh1|y.txt', 'h2', { local: path.join(verifiedOnly, 'y.txt') })
  const goneFolder = peer.tmpDir('gone-space')
  await markDownloaded('0123456789abcdef', '/z.txt', path.join(goneFolder, 'z.txt'), { hash: 'h3', destDir: goneFolder })

  await rebootPeer(t, peer)

  t.ok(listDownloadRoots().includes(oldFolder), 'the folder the legacy copy sits in is a download root')
  t.ok((await listRevealRoots()).includes(oldFolder), 'so Reveal may open it')
  t.absent(listDownloadRoots().includes(verifiedOnly), 'a verified record is never read as a claim')
  t.absent(listDownloadRoots().includes(goneFolder), 'and only the claims of spaces this device has are read')
})

// REGRESSION (FIX-DLTO-R33: the landed folders were module state that only grew, so a boot in a
// process that had booted before kept the last session's folders as download roots — Reveal and the
// boot sweep reached folders nothing on this store names.)
test('REGRESSION (FIX-DLTO-R33: each boot starts the landed folders from what its store names)', async (t) => {
  const peer = await freshPeer(t)
  const started = peer.tmpDir('started-then-cancelled')
  noteLandedFolders([started])
  t.ok(listDownloadRoots().includes(started), 'precondition: a download root for this session')

  await rebootPeer(t, peer)

  t.absent(listDownloadRoots().includes(started), 'the next boot reads only the folders its rows and claims name')
})
