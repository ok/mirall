import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// FIX-21 — "downloaded / on your device" used to be a bare key in downloads-meta
// (keyed by spaceId:filePath), never checked against disk. So the claim outlived
// the bytes: a peer that deleted its local copy — or whose owner removed and later
// re-shared the path — kept showing the file as downloaded though it no longer had
// it. The status must reflect what is actually on disk, and an upstream removal
// must reset the claim (while keeping any file the peer already downloaded).

function statusOf (list, rel) {
  return list?.entries?.find((f) => f.relPath === rel)?.status
}
function localOf (list, rel) {
  return list?.entries?.find((f) => f.relPath === rel)?.localPath
}

test('REGRESSION (FIX-21): a kept copy stays on-device when the owner removes then re-shares the same content', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const aDownloads = mkTmpDir(t)
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: aDownloads })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'a.txt'), 'aaa')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  // B downloads a.txt → downloaded, with a local path on disk.
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'a.txt'))
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Notes/a.txt', 60000)
  await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'a.txt' })
  await done
  const afterDl = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => statusOf(f, 'a.txt') === 'downloaded')
  const localPath = localOf(afterDl, 'a.txt')
  t.ok(localPath && fs.existsSync(localPath), 'downloaded file is on disk')

  // Owner removes a.txt from the share (delete on disk + the watcher's unlink).
  fs.unlinkSync(path.join(folder, 'a.txt'))
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'unlink', relPath: 'a.txt', absPath: path.join(folder, 'a.txt') })
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && !f.entries.some((e) => e.relPath === 'a.txt'), { ms: 60000 })

  // Owner re-shares the same content at the same path.
  fs.writeFileSync(path.join(folder, 'a.txt'), 'aaa')
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'add', relPath: 'a.txt', absPath: path.join(folder, 'a.txt') })

  // B still has the bytes on disk and they match the re-shared content, so the
  // file is on-device again — no needless re-download.
  const after = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => !!f?.entries?.some((e) => e.relPath === 'a.txt'), { ms: 60000 })
  t.is(statusOf(after, 'a.txt'), 'downloaded', 're-shared identical content stays on-device')
  t.ok(fs.existsSync(localPath), 'the previously-downloaded copy is still on disk')
})
