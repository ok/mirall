import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, mkStoreDir, patternedBytes, waitForSize } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { MOUNT_STATUS } from '../../src/shared/contract/statuses.js'

// A short foreign poll so the mirror re-walks promptly once the owner is back.
const MIRROR_FLAGS = { foreignPollIntervalMs: 1500 }
// Bob's download cap while the owner is up: 32 MiB at 1 MiB/s cannot finish before the kill that
// follows its first progress frame, however fast the loopback is.
const SIZE = 32 * 1024 * 1024
const CAPPED_KBPS = 1024

// A wait armed ahead of the action that satisfies it. Should the test fail before it is awaited,
// its later rejection is already handled rather than an unhandled one.
function armed(wait) {
  wait.catch(() => {})
  return wait
}

// The only holder of a file vanishing while a mirror is fetching it is a fact about the network,
// not about this device: the fetch ends, the mount stays enabled with no fault recorded, and the
// file arrives once the owner is back, without anyone resuming the mirror.
test('an owner quitting mid-fetch leaves the mirror running, and the file lands when they return',
  { timeout: scaled(240000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const aStore = mkStoreDir(t)
    let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: MIRROR_FLAGS })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).personKey

    const share = await A.request('share:create', { spaceId, name: 'Bulk', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    const bytes = patternedBytes(SIZE, 11)
    fs.writeFileSync(path.join(folder, 'big.bin'), bytes)
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    await B.until('share:list', { spaceId }, (l) => Array.isArray(l) && l.some((s) => s.id === share.id), { ms: 60000 })
    await B.request('settings:set-bandwidth', { downloadKBps: CAPPED_KBPS })

    const dest = mkTmpDir(t)
    const destFile = path.join(dest, 'big.bin')
    const key = share.id + ':big.bin'
    const isMine = (m) => m.channel === 'transfer' && m.key === key

    const firstProgress = armed(B.waitFor('event:decoration',
      (m) => isMine(m) && !m.done && m.bytes > 0 && m.bytes < SIZE, 90000))
    await B.request('foreign-folder:mount', { spaceId, ownerKey: aKey, shareId: share.id, mountPath: dest })
    await firstProgress
    t.absent(fs.existsSync(destFile), 'precondition: the fetch is still in flight when the owner quits')

    // Armed after the progress frame, so only the fetch the kill interrupts can meet it.
    const fetchEnded = armed(B.waitFor('event:decoration', (m) => isMine(m) && m.done, 120000))
    A.kill()
    await fetchEnded

    t.absent(fs.existsSync(destFile), 'the file did not land: the owner left before it could finish')
    // The terminal frame goes out before the miss is classified, and a poll tick that ran the fetch
    // emits no status edge, so the record is read as a level: past scanning, and the same twice.
    let last = null
    const mount = await B.until('foreign-folder:get', { spaceId, shareId: share.id }, (m) => {
      const seen = JSON.stringify([m?.enabled, m?.status, m?.lastError])
      const steady = seen === last && m.status !== MOUNT_STATUS.SCANNING
      last = seen
      return steady
    }, { ms: 60000, every: 500 })
    t.is(mount.enabled, true, 'the mirror was not paused for the owner leaving')
    t.is(mount.status, MOUNT_STATUS.ACTIVE, 'and no local fault was recorded')
    t.absent(mount.lastError, 'nor an error against the mount')
    await B.until('members:online', { spaceId }, (o) => !o.includes(aKey), { ms: 90000 })

    await B.request('settings:set-bandwidth', { downloadKBps: 0 })
    A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore })
    await waitForSize(destFile, SIZE, { ms: 120000 })
    t.ok(fs.readFileSync(destFile).equals(bytes), 'the file landed byte-exact once the owner returned')

    A.kill()
  })
