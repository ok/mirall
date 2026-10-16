import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { tmpDir } from '../helpers/bare-tmp.js'
import { registerSettings } from '../../src/worker/ipc/settings.js'
import { getBandwidthLimits, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getNewSpaceDownloadDir, listDownloadRoots } from '../../src/shared/core/paths.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { getSpace } from '../../src/shared/spaces/space.js'

async function setup(t) {
  const peer = await freshPeer(t)
  let published = 0
  registerSettings(peer.fake.ipc, { mounts: peer.root.mounts, publishRevealRoots: () => { published++ } })
  const file = path.join(path.dirname(peer.storage), 'settings.json')
  const stored = () => JSON.parse(fs.readFileSync(file, 'utf-8'))
  const pokes = () => peer.fake.emitted('event:reconcile').filter((e) => e.payload?.scope?.kind === 'settings').length
  return { ...peer, stored, pokes, published: () => published }
}

test('settings:get reports the folder new spaces start in, the recent folders, the caps and the host', async (t) => {
  const p = await setup(t)
  const view = await p.fake.call('settings:get', {})
  t.is(view.downloads.folder, getNewSpaceDownloadDir())
  t.alike(view.downloads.recent, [getNewSpaceDownloadDir()], 'boot seeds the recent list with the folder in use')
  t.ok(view.downloads.isDefault, 'nothing stored: the default stands')
  t.alike(view.network, { downloadKBps: 0, uploadKBps: 0, relayMode: 'off', relay: null })
  t.absent('downloadConcurrency' in view.network, 'no UI for the operator lever')
  const platform = os.platform()
  t.alike(view.hostPaths, { home: os.homedir(), sep: path.sep, caseFolds: platform === 'darwin' || platform === 'win32' })
})

test('settings:set-bandwidth persists, applies and pokes every client', async (t) => {
  const p = await setup(t)
  const view = await p.fake.call('settings:set-bandwidth', { downloadKBps: 512 })
  t.is(view.network.downloadKBps, 512)
  t.is(view.network.uploadKBps, 0, 'the omitted direction keeps its cap')
  t.is(p.stored().network.downloadKBps, 512, 'written through')
  t.is(getBandwidthLimits().download, 512 * 1024, 'and live')
  t.is(p.pokes(), 1)
  const again = await p.fake.call('settings:set-bandwidth', { downloadKBps: -1, uploadKBps: 64.9 })
  t.is(again.network.downloadKBps, 512, 'a corrupt cap keeps the one the user last set')
  t.is(again.network.uploadKBps, 64, 'a fractional cap is floored')
})

test('settings:set-download-folder validates, persists, republishes the roots and pokes', async (t) => {
  const p = await setup(t)
  const folder = tmpDir('settings-dl', t)
  const view = await p.fake.call('settings:set-download-folder', { folder })
  t.absent(view.downloads.isDefault)
  t.is(path.resolve(view.downloads.folder), path.resolve(folder))
  t.is(path.resolve(p.stored().downloads.folder), path.resolve(folder))
  t.is(path.resolve(getRuntimeConfig().downloadFolder), path.resolve(folder), 'live')
  t.is(p.published(), 1, 'the reveal allow-list is republished')
  t.is(p.pokes(), 1)

  const back = await p.fake.call('settings:set-download-folder', {})
  t.ok(back.downloads.isDefault, 'omitting the folder returns to the default')
  t.is(p.stored().downloads.folder, null)
  t.is(getNewSpaceDownloadDir(), back.downloads.folder)
})

test('a refused folder leaves the file and the live config untouched', async (t) => {
  const p = await setup(t)
  const before = p.stored()
  await t.exception(p.fake.call('settings:set-download-folder', { folder: 'relative/path' }))
  await t.exception(p.fake.call('settings:set-download-folder', { folder: path.join(tmpDir('settings-missing', t), 'nope') }))
  t.alike(p.stored(), before)
  t.is(p.pokes(), 0, 'nothing changed, nobody is told')
  t.is(p.published(), 0)
})

test('the roots the worker publishes carry the stored folder, so main needs no copy of it', async (t) => {
  const p = await setup(t)
  await createSpace('A space')
  const folder = tmpDir('settings-dl-roots', t)
  await p.fake.call('settings:set-download-folder', { folder })
  t.ok(listDownloadRoots().some((r) => path.resolve(r) === path.resolve(folder)), 'the stored folder is a root main authorises reveals under')
  t.is(p.published(), 1, 'and it was pushed to main the moment it changed')
})

test('settings:set-download-folder seeds new spaces and moves no existing one', async (t) => {
  const p = await setup(t)
  const space = await createSpace('Before')
  const before = space.downloadFolder
  const folder = tmpDir('settings-dl-seed', t)
  await p.fake.call('settings:set-download-folder', { folder })
  t.is((await getSpace(space.spaceId)).downloadFolder, before, 'the existing space keeps its folder')
  const later = await createSpace('After')
  t.is(path.resolve(later.downloadFolder), path.resolve(folder), 'a space created afterwards starts in it')
})
