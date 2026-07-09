import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

// The content backend's observable status matrix: remote → downloaded → synced →
// unavailable. Overlay is the only backend; a future one is validated by adding
// another runContract case.
//
// Two shares are used because mirroring makes every file local ('synced'), which
// would mask 'unavailable': one share B downloads-from + mirrors, one B only
// browses so an un-fetched file can go 'unavailable' when the owner drops.
function runContract(label, { flags, contentMode }) {
  const statusOf = (list, rel) => (Array.isArray(list?.entries) ? list.entries.find((e) => e.relPath === rel)?.status : undefined)
  const totalOf = (info, spaceId) => {
    const s = (info?.spaces || []).find((x) => x.spaceId === spaceId)
    return s ? s.totalBytes : 0
  }

  test(`[${label}] status matrix: remote → downloaded → synced → unavailable`,
    { timeout: 150000 }, async (t) => {
      const bootstrap = await localTestnet(t)
      const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags })
      const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags })
      const spaceId = await connectInSpace(t, A, B)
      const aKey = (await A.request('profile:get')).publicKey

      const shareM = await A.request('share:create', { spaceId, name: 'Mirror', contentMode })
      const shareB = await A.request('share:create', { spaceId, name: 'Browse', contentMode })
      t.is(shareM.contentMode ?? null, contentMode, 'content mode stamped per the backend')

      const folderM = mkTmpDir(t)
      const m1 = patternedBytes(64 * 1024, 1)
      fs.writeFileSync(path.join(folderM, 'm1.bin'), m1)
      fs.writeFileSync(path.join(folderM, 'm2.bin'), patternedBytes(64 * 1024, 2))
      const folderB = mkTmpDir(t)
      fs.writeFileSync(path.join(folderB, 'b1.bin'), patternedBytes(32 * 1024, 3))

      const before = await A.request('storage:info')
      const scanM = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === shareM.id)
      await A.request('owned-folder:mount', { spaceId, shareId: shareM.id, mountPath: folderM })
      await scanM
      const scanB = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === shareB.id)
      await A.request('owned-folder:mount', { spaceId, shareId: shareB.id, mountPath: folderB })
      await scanB

      const info = await A.request('storage:info')
      // Overlay advertises from source: mounting + scanning the two 64 KiB files must NOT grow
      // the per-space drive by the file bytes. A backend that imported content would grow it by
      // >= m1+m2. (Reading the hardcoded contentBytes:0 would have made this pass vacuously.)
      t.ok(totalOf(info, spaceId) - totalOf(before, spaceId) < m1.length, `${label}: advertise only — no file bytes imported up front`)

      // remote — visible, owner online, nothing local.
      const remote = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: shareM.id },
        (f) => statusOf(f, 'm1.bin') === 'remote' && statusOf(f, 'm2.bin') === 'remote')
      t.is(statusOf(remote, 'm1.bin'), 'remote', 'remote: owner online, not local')

      // downloaded — browse-only download lands in the global Downloads folder.
      // All three backends are non-blocking and fire transfer-complete on finish.
      const done = B.waitFor('event:transfer-complete', (msg) => msg.path === '/Mirror/m1.bin', 120000)
      const dlRes = await B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: shareM.id, relPath: 'm1.bin' })
      t.ok(dlRes?.transferId, 'download returned a transferId')
      await done
      const dl = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: shareM.id },
        (f) => statusOf(f, 'm1.bin') === 'downloaded', { ms: 30000 })
      t.is(statusOf(dl, 'm1.bin'), 'downloaded', 'downloaded: on device via browse download')

      // synced — mirror the share to disk; on-disk files read as synced.
      const dest = mkTmpDir(t)
      await B.request('foreign-folder:mount', { spaceId, ownerKey: aKey, shareId: shareM.id, mountPath: dest })
      const synced = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: shareM.id },
        (f) => statusOf(f, 'm2.bin') === 'synced', { ms: 60000 })
      t.is(statusOf(synced, 'm2.bin'), 'synced', 'synced: mirrored to disk, not "available"')

      // unavailable — a never-fetched file in the browse-only share, owner offline.
      // Browse it first so its listing is cached locally before the owner drops.
      await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: shareB.id },
        (f) => statusOf(f, 'b1.bin') === 'remote')
      A.kill()
      await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })
      const un = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: shareB.id },
        (f) => statusOf(f, 'b1.bin') === 'unavailable', { ms: 30000 })
      t.is(statusOf(un, 'b1.bin'), 'unavailable', 'unavailable: not local, owner offline')
    })
}

runContract('overlay', { flags: { overlayEnabled: true }, contentMode: 'overlay' })
