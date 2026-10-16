import test from 'brittle'
import crypto from 'hypercore-crypto'
import { freshPeer, rebootPeer } from '../helpers/store.js'
import { createSpace, joinSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getSpace, mutateSpace, setSpaceDownloadFolder, _spacesBeeForTests } from '../../src/shared/spaces/space.js'
import { getDownloadDir, getNewSpaceDownloadDir } from '../../src/shared/core/paths.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getSettings, updateSettings } from '../../src/shared/core/settings-store.js'

// Every space has its own download folder. The app folder seeds a space when it is created or
// joined, and boot gives a record from before that the app folder as it is set then. Nothing moves a
// space that has a folder.

function useAppFolder(t, folder) {
  const prev = getRuntimeConfig()
  setRuntimeConfig({ ...prev, downloadFolder: folder })
  t.teardown(() => setRuntimeConfig(prev))
}

test('a created space stores the app folder, and a changed app folder never moves it', async (t) => {
  const ctx = await freshPeer(t)
  const seed = getNewSpaceDownloadDir()
  const space = await createSpace('Aurora')
  t.is((await getSpace(space.spaceId)).downloadFolder, seed)

  useAppFolder(t, ctx.tmpDir('dl-later'))
  await rebootPeer(t, ctx)
  t.is(getDownloadDir(space.spaceId), seed)
})

test('a new join record stores the app folder; a re-join of an existing record writes nothing', async (t) => {
  const ctx = await freshPeer(t)
  const topic = crypto.randomBytes(32).toString('hex')
  const joined = await joinSpace(topic, 'Joined')
  t.is((await getSpace(joined.spaceId)).downloadFolder, getNewSpaceDownloadDir())

  const own = ctx.tmpDir('dl-own')
  await setSpaceDownloadFolder(joined.spaceId, own)
  useAppFolder(t, ctx.tmpDir('dl-later'))
  const length = _spacesBeeForTests().core.length
  await joinSpace(topic, 'Joined')
  t.is((await getSpace(joined.spaceId)).downloadFolder, own, 'the record keeps its folder')
  t.is(_spacesBeeForTests().core.length, length, 'and the space record was not rewritten')
})

test('boot backfills a record with no folder, leaves one that has a folder, and starts the recent list', async (t) => {
  let ctx = await freshPeer(t)
  const legacy = await createSpace('Legacy')
  await mutateSpace(legacy.spaceId, (s) => {
    const next = { ...s }
    delete next.downloadFolder
    return next
  })
  const kept = await createSpace('Kept')
  const own = ctx.tmpDir('dl-own')
  await setSpaceDownloadFolder(kept.spaceId, own)
  await updateSettings((s) => { s.downloads.recent = []; return s })
  const app = ctx.tmpDir('dl-app')
  useAppFolder(t, app)

  ctx = await rebootPeer(t, ctx)
  t.is((await getSpace(legacy.spaceId)).downloadFolder, app, 'the legacy record downloads where the app folder is now')
  t.is((await getSpace(kept.spaceId)).downloadFolder, own, 'a record with a folder keeps it')
  t.is(getDownloadDir(legacy.spaceId), app)
  t.is(getDownloadDir(kept.spaceId), own)
  t.alike(getSettings().downloads.recent, [app, own], 'the recent list starts from the folders in use, the app folder first')

  const length = _spacesBeeForTests().core.length
  const recent = getSettings().downloads.recent
  useAppFolder(t, ctx.tmpDir('dl-app-2'))
  await rebootPeer(t, ctx)
  t.is(_spacesBeeForTests().core.length, length, 'a second boot writes no space record')
  t.is((await getSpace(legacy.spaceId)).downloadFolder, app, 'and moves no space to the new app folder')
  t.alike(getSettings().downloads.recent, recent, 'and leaves the recent list alone')
})
