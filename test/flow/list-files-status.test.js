import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

// share:list-files derives a per-file status the UI renders as a badge. The
// branches: own folder → 'synced'; foreign browse, owner online, not downloaded
// → 'remote'; after an on-demand download → 'downloaded'; owner offline and not
// local → 'unavailable'; foreign mirror with the file present → 'synced'.

function statusOf (list, rel) {
  return list?.entries?.find((f) => f.relPath === rel)?.status
}

test('status derivation: synced / remote / downloaded / unavailable', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'a.txt'), 'aaa')
  fs.writeFileSync(path.join(folder, 'b.txt'), 'bbb')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  // Owner's own view → synced, with a local path.
  const ownList = await A.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
  t.is(statusOf(ownList, 'a.txt'), 'synced', 'owner sees its own files as synced')
  t.ok(ownList.entries.find((f) => f.relPath === 'a.txt').localPath, 'owner file has a local path')

  // Peer browse (owner online, not downloaded) → remote.
  const remote = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.length === 2)
  t.is(statusOf(remote, 'a.txt'), 'remote', 'peer browse → remote while owner online')

  // Download a.txt on demand → downloaded.
  const done = B.waitFor('event:transfer-complete', (m) => m.path === '/Notes/a.txt', 60000)
  await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'a.txt' })
  await done
  const afterDl = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => statusOf(f, 'a.txt') === 'downloaded')
  t.is(statusOf(afterDl, 'a.txt'), 'downloaded', 'on-demand download flips a.txt to downloaded')

  // Owner offline: a.txt stays downloaded (cached), b.txt becomes unavailable.
  A.kill()
  await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })
  const offline = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => statusOf(f, 'b.txt') === 'unavailable')
  t.is(statusOf(offline, 'a.txt'), 'downloaded', 'cached file stays downloaded while owner offline')
  t.is(statusOf(offline, 'b.txt'), 'unavailable', 'un-cached file is unavailable while owner offline')
})

test('status derivation: a mirrored file present on disk reports synced', { timeout: 120000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Media' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'x.txt'), 'content')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active

  const list = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => statusOf(f, 'x.txt') === 'synced')
  t.is(statusOf(list, 'x.txt'), 'synced', 'mirrored file present on disk → synced')
  t.ok(list.entries.find((f) => f.relPath === 'x.txt').localPath.startsWith(mirrorDir), 'localPath points into the mirror')
})

test('status derivation: a mirrored file not yet on disk reports remote/downloading', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Bulk' })
  const folder = mkTmpDir(t)
  // Large enough that the mirror sync is still in flight when we first read the
  // list — the un-synced row is exactly the state the folder view must NOT turn
  // into a manual Download button (asserted at the unit + UI layers).
  fs.writeFileSync(path.join(folder, 'big.bin'), Buffer.alloc(96 * 1024 * 1024, 9))
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })

  const list = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => ['remote', 'downloading'].includes(statusOf(f, 'big.bin')))
  t.ok(['remote', 'downloading'].includes(statusOf(list, 'big.bin')),
    'un-synced mirrored file is remote/downloading, never a manual-download candidate')
})
