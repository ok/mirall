import test from 'brittle'
import os from 'bare-os'
import path from 'bare-path'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  getDownloadDir, getNewSpaceDownloadDir, hydrateDownloadRoots,
  setSpaceDownloadRoot, forgetSpaceDownloadRoot, isInsideDownloadDir, isSameFolder,
  listCurrentDownloadFolders, listOfferedDownloadFolders, listDownloadRoots,
  setRecentDownloadFolders, noteLandedFolders, setLandedFolders, setDownloadRootsListener, hostFoldsCase,
} from '../../src/shared/core/paths.js'

// Each space downloads into its own folder, mirrored here from the space records; the app folder
// only seeds new spaces. paths.js never reads the bee itself.

const SEED = path.join(os.tmpdir(), 'mirall-dl-seed')
const A = path.join(os.tmpdir(), 'mirall-dl-a')
const B = path.join(os.tmpdir(), 'mirall-dl-b')
const R = path.join(os.tmpdir(), 'mirall-dl-recent')
const L = path.join(os.tmpdir(), 'mirall-dl-landed')

function withSeed(t) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadFolder: SEED })
  hydrateDownloadRoots([])
  setRecentDownloadFolders([])
  setLandedFolders([])
  t.teardown(() => {
    setDownloadRootsListener(null)
    setRuntimeConfig(prev)
    hydrateDownloadRoots([])
    setRecentDownloadFolders([])
    setLandedFolders([])
  })
}

test('a space answers its own folder, and a sibling is unaffected', (t) => {
  withSeed(t)
  setSpaceDownloadRoot('space1', A)
  t.is(getDownloadDir('space1'), A)
  t.is(getDownloadDir('space2'), SEED, 'a space with no folder yet answers the seed')
  t.is(getNewSpaceDownloadDir(), SEED, 'the seed itself never moves')
})

test('a changed app folder moves no space that has a folder', (t) => {
  withSeed(t)
  setSpaceDownloadRoot('space1', A)
  setRuntimeConfig({ ...getRuntimeConfig(), downloadFolder: B })
  t.is(getDownloadDir('space1'), A)
  t.is(getNewSpaceDownloadDir(), B)
})

test('a forgotten or emptied space answers the seed, never null', (t) => {
  withSeed(t)
  setSpaceDownloadRoot('space1', A)
  forgetSpaceDownloadRoot('space1')
  t.is(getDownloadDir('space1'), SEED)
  setSpaceDownloadRoot('space1', '')
  t.is(getDownloadDir('space1'), SEED)
  t.is(getDownloadDir(undefined), SEED)
  t.is(getDownloadDir(null), SEED)
})

test('hydrate replaces the whole map and skips records with no folder', (t) => {
  withSeed(t)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: A }])
  hydrateDownloadRoots([{ spaceId: 'space2', downloadFolder: B }, { spaceId: 'space3' }, { spaceId: 'space4', downloadFolder: '' }])
  t.is(getDownloadDir('space1'), SEED, 'the earlier folder is gone')
  t.is(getDownloadDir('space2'), B)
  t.is(getDownloadDir('space3'), SEED)
  t.is(getDownloadDir('space4'), SEED)
})

test('the current folders are the seed and every space\'s folder, once each', (t) => {
  withSeed(t)
  hydrateDownloadRoots([
    { spaceId: 'space1', downloadFolder: A },
    { spaceId: 'space2', downloadFolder: A },
    { spaceId: 'space3', downloadFolder: B },
  ])
  setRecentDownloadFolders([R])
  noteLandedFolders([L])
  t.alike(listCurrentDownloadFolders(), [SEED, A, B], 'neither a recent nor a landed folder is current')
})

test('the offered folders add the recent ones, once each', (t) => {
  withSeed(t)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: A }])
  setRecentDownloadFolders([A, R, SEED])
  noteLandedFolders([L])
  t.alike(listOfferedDownloadFolders(), [SEED, A, R], 'a landed folder is not offered')
})

test('the download roots add every landed folder, once each', (t) => {
  withSeed(t)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: A }])
  setRecentDownloadFolders([R])
  noteLandedFolders([L, A, L])
  t.alike(listDownloadRoots(), [SEED, A, R, L])
})

test('noting landed folders notifies once per call, and only when a folder is new', (t) => {
  withSeed(t)
  let calls = 0
  setDownloadRootsListener(() => { calls++ })
  noteLandedFolders([L, A])
  t.is(calls, 1, 'two new folders, one notification')
  noteLandedFolders([L])
  t.is(calls, 1, 'a known folder is silent')
  noteLandedFolders([null, '', undefined])
  t.is(calls, 1, 'nothing usable is silent')
  noteLandedFolders([B])
  t.is(calls, 2)
})

test('setting the landed folders replaces them, and always notifies', (t) => {
  withSeed(t)
  let calls = 0
  setDownloadRootsListener(() => { calls++ })
  noteLandedFolders([L, A])
  setLandedFolders([B, null, ''])
  t.alike(listDownloadRoots(), [SEED, B], 'only the folders set now')
  t.is(calls, 2)
  setLandedFolders([])
  t.alike(listDownloadRoots(), [SEED], 'an empty set drops them all')
  t.is(calls, 3, 'a set that shrinks is a change too')
})

test('isInsideDownloadDir matches self and descendants, not a name-prefix sibling', (t) => {
  t.ok(isInsideDownloadDir(A, A), 'the root itself')
  t.ok(isInsideDownloadDir(path.join(A, 'f.txt'), A))
  t.ok(isInsideDownloadDir(path.join(A, 'sub', 'f.txt'), A), 'nested')
  t.absent(isInsideDownloadDir(path.join(A + 'x', 'f.txt'), A), 'name-prefix sibling')
  t.absent(isInsideDownloadDir(path.join(B, 'f.txt'), A), 'a different root')
})

test('isSameFolder ignores a trailing separator and is not a containment test', (t) => {
  t.ok(isSameFolder(A, A + path.sep))
  t.absent(isSameFolder(A, path.join(A, 'sub')))
  t.absent(isSameFolder(A, ''))
})

// One case-fold rule for the host: every comparison here, mount validation and the paths a client
// is sent (the settings view's `caseFolds`) all read hostFoldsCase.
test('folder comparisons fold case exactly when the host does', (t) => {
  const folds = hostFoldsCase()
  t.is(folds, os.platform() === 'darwin' || os.platform() === 'win32', 'macOS and Windows fold, other hosts do not')
  t.is(isSameFolder(A, A.toUpperCase()), folds)
  t.is(isInsideDownloadDir(path.join(A, 'f.txt').toUpperCase(), A), folds)
})
