import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

// Mirroring a foreign folder must surface per-file download progress the same
// way an individual file download does — otherwise the receiving peer's folder
// view shows no bar while the bytes stream in. This asserts the worker emits
// event:decoration frames (channel 'transfer', keyed shareId:relPath) during
// materialize with a correct total and monotonic byte counts, and that the
// file still lands byte-exact.
test('B sees per-file mirror progress with correct total and monotonic bytes', { timeout: 90000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  // A publishes a folder with one sizable file so the blob streams in several
  // blocks rather than a single instant write.
  const share = await A.request('share:create', { spaceId, name: 'Photos' })
  const folder = mkTmpDir(t)
  const bigBytes = patternedBytes(512 * 1024, 23)
  fs.writeFileSync(path.join(folder, 'big.bin'), bigBytes)
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))

  // Collect every progress decoration for this share before the mount starts.
  const progress = []
  B.on('event:decoration', (m) => {
    if (m.channel === 'transfer' && typeof m.key === 'string' && m.key.startsWith(share.id + ':')) progress.push(m)
  })

  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active')
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active

  // At least one progress frame fired for the file (the terminal done-frame is excluded).
  const forFile = progress.filter((p) => p.key === share.id + ':big.bin' && !p.done && !p.phase)
  t.ok(forFile.length >= 1, 'at least one progress decoration for big.bin')

  // Payload shape + invariants: correct spaceId/total, bytes monotonic and never
  // exceeding the total.
  let prev = 0
  for (const p of forFile) {
    t.is(p.spaceId, spaceId, 'event carries the spaceId')
    t.is(p.total, bigBytes.length, 'total equals the source file size')
    t.ok(p.bytes > 0 && p.bytes <= p.total, 'bytes within (0, total]')
    t.ok(p.bytes >= prev, 'bytes are monotonic non-decreasing')
    t.ok(typeof p.speed === 'number' && p.speed >= 0, 'speed is a non-negative number')
    prev = p.bytes
  }

  // The mirror still completed byte-exact.
  t.ok(fs.readFileSync(path.join(mirrorDir, 'big.bin')).equals(bigBytes), 'big.bin bytes match source')
})
