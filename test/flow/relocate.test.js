import test from 'brittle'
import fs from 'fs'
import os from 'os'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

const SYSTEM_PATH = {
  darwin: '/System/Library/x',
  linux: '/proc/x',
  win32: 'C:\\Windows\\x',
}[os.platform()] || '/proc/x'

// Relocate re-points an owned folder at a new on-disk location (after the source
// was moved/renamed). The hash-based reconcile must recognize identical content
// at the new path and upload NOTHING — that "no churn" is the whole reason
// relocate beats delete-and-re-add: mirror peers see no drive change.
test('relocating to an identical copy uploads nothing (no mirror churn)', async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const spaceId = (await A.request('space:create', { name: 'Aurora' })).spaceId

  const share = await A.request('share:create', { spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'one.txt'), 'hello')
  fs.writeFileSync(path.join(folder, 'two.txt'), 'world')
  const firstScan = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  t.is((await firstScan).uploaded, 2, 'initial mount publishes both files')

  // An identical copy at a new location.
  const moved = mkTmpDir(t)
  fs.writeFileSync(path.join(moved, 'one.txt'), 'hello')
  fs.writeFileSync(path.join(moved, 'two.txt'), 'world')

  const reScan = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:relocate', { spaceId, shareId: share.id, mountPath: moved })
  const r = await reScan
  t.is(r.uploaded, 0, 'identical content at the new path uploads nothing')
  t.is(r.deleted, 0, 'and deletes nothing')

  const mount = await A.request('owned-folder:get', { spaceId, shareId: share.id })
  t.not(mount.mountPath, folder, 'mount no longer points at the old path')
  t.is(path.basename(mount.mountPath), path.basename(moved), 'mount now points at the new path')

  const files = await A.request('share:list-files', { spaceId, ownerKey: (await A.request('profile:get')).publicKey, shareId: share.id })
  t.alike(files.entries.map((f) => f.relPath).sort(), ['one.txt', 'two.txt'], 'drive contents unchanged')
})

test('relocating to a forbidden path is rejected and the original mount is unchanged', async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const spaceId = (await A.request('space:create', { name: 'Aurora' })).spaceId

  const share = await A.request('share:create', { spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'keep.txt'), 'data')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone
  const original = (await A.request('owned-folder:get', { spaceId, shareId: share.id })).mountPath

  await t.exception(
    A.request('owned-folder:relocate', { spaceId, shareId: share.id, mountPath: SYSTEM_PATH }),
    'relocate to a system folder is rejected',
  )
  const after = await A.request('owned-folder:get', { spaceId, shareId: share.id })
  t.is(after.mountPath, original, 'mount path is left untouched after a rejected relocate')
})
