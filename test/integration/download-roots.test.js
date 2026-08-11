import test from 'brittle'
import os from 'bare-os'
import path from 'bare-path'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  getDownloadDir, getGlobalDownloadDir, hydrateDownloadRoots,
  setSpaceDownloadRoot, forgetSpaceDownloadRoot, listDownloadRoots, isInsideDownloadDir,
  getSpaceDownloadOverride,
} from '../../src/shared/core/paths.js'

// A space with no override inherits the global root, so an existing install sees no
// state change on upgrade. Overrides live in an in-memory map hydrated from the space
// records at boot — paths.js never reads the bee itself.

const GLOBAL = path.join(os.tmpdir(), 'mirall-dl-global')
const A = path.join(os.tmpdir(), 'mirall-dl-a')
const B = path.join(os.tmpdir(), 'mirall-dl-b')

function withGlobal (t) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadFolder: GLOBAL })
  t.teardown(() => { setRuntimeConfig(prev); hydrateDownloadRoots([]) })
}

test('an unset space inherits the global root', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([])
  t.is(getDownloadDir('space1'), GLOBAL)
  t.is(getGlobalDownloadDir(), GLOBAL)
})

test('an override applies only to its own space', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([])
  setSpaceDownloadRoot('space1', A)
  t.is(getDownloadDir('space1'), A)
  t.is(getDownloadDir('space2'), GLOBAL, 'a sibling space is unaffected')
  t.is(getGlobalDownloadDir(), GLOBAL, 'the global root itself never moves')
})

test('clearing an override reverts the space to the global root', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([])
  setSpaceDownloadRoot('space1', A)
  setSpaceDownloadRoot('space1', null)
  t.is(getDownloadDir('space1'), GLOBAL)
  setSpaceDownloadRoot('space1', A)
  forgetSpaceDownloadRoot('space1')
  t.is(getDownloadDir('space1'), GLOBAL, 'forget behaves like a clear')
})

test('an empty-string override is treated as unset', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([])
  setSpaceDownloadRoot('space1', '')
  t.is(getDownloadDir('space1'), GLOBAL)
})

test('hydrate replaces the whole map rather than merging into it', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: A }])
  t.is(getDownloadDir('space1'), A)
  hydrateDownloadRoots([{ spaceId: 'space2', downloadFolder: B }])
  t.is(getDownloadDir('space1'), GLOBAL, 'the earlier override is gone')
  t.is(getDownloadDir('space2'), B)
})

test('hydrate ignores records with no usable override', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([
    { spaceId: 'space1' },
    { spaceId: 'space2', downloadFolder: null },
    { spaceId: 'space3', downloadFolder: '' },
    { spaceId: 'space4', downloadFolder: A },
  ])
  t.is(getDownloadDir('space1'), GLOBAL)
  t.is(getDownloadDir('space2'), GLOBAL)
  t.is(getDownloadDir('space3'), GLOBAL)
  t.is(getDownloadDir('space4'), A)
})

test('a missing spaceId resolves to the global root', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: A }])
  t.is(getDownloadDir(undefined), GLOBAL)
  t.is(getDownloadDir(null), GLOBAL)
})

// The boot partial sweep and mount validation both iterate this, so a duplicate would
// make them do redundant work and a missing global would leave partials unswept.
test('listDownloadRoots is the deduplicated union including the global root', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([
    { spaceId: 'space1', downloadFolder: A },
    { spaceId: 'space2', downloadFolder: A },
    { spaceId: 'space3', downloadFolder: B },
  ])
  const roots = listDownloadRoots()
  t.is(roots.length, 3, 'global + two distinct overrides')
  t.ok(roots.includes(GLOBAL))
  t.ok(roots.includes(A))
  t.ok(roots.includes(B))
})

test('listDownloadRoots is just the global root when nothing is overridden', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([])
  t.alike(listDownloadRoots(), [GLOBAL])
})

// Download claims scope on the OVERRIDE, never the effective root — the difference between
// "this space keeps its files here" and "this space follows the app default".
test('getSpaceDownloadOverride reports only an explicit override', (t) => {
  withGlobal(t)
  hydrateDownloadRoots([{ spaceId: 'space1', downloadFolder: A }])
  t.is(getSpaceDownloadOverride('space1'), A)
  t.is(getSpaceDownloadOverride('space2'), null, 'a space on the global root has no override')
  t.is(getSpaceDownloadOverride(undefined), null)
  setSpaceDownloadRoot('space1', null)
  t.is(getSpaceDownloadOverride('space1'), null, 'cleared is the same as never set')
})

test('isInsideDownloadDir matches self and descendants, not a name-prefix sibling', (t) => {
  t.ok(isInsideDownloadDir(A, A), 'the root itself')
  t.ok(isInsideDownloadDir(path.join(A, 'f.txt'), A))
  t.ok(isInsideDownloadDir(path.join(A, 'sub', 'f.txt'), A), 'nested')
  t.absent(isInsideDownloadDir(path.join(A + 'x', 'f.txt'), A), 'name-prefix sibling')
  t.absent(isInsideDownloadDir(path.join(B, 'f.txt'), A), 'a different root')
})
