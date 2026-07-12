import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

function countFiles(dir) {
  try { return fs.readdirSync(dir).filter((n) => !n.endsWith('.mirall.part')).length } catch { return 0 }
}

// REGRESSION: unmounting a mirror mid-sync must actually stop the materialize
// pass. Previously stopForeignLoop only cleared the poll timer, so an in-flight
// scan over many files ran to completion (and its trailing saveForeignMount even
// recreated the unmounted mount, resuming it on the next launch).
test('REGRESSION (mirror): unmount mid-sync stops it and does not resurrect the mount',
  { timeout: 150000 }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t) })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Bulk' })
    const src = mkTmpDir(t)
    for (let i = 0; i < 12; i++) {
      fs.writeFileSync(path.join(src, `f${i}.bin`), patternedBytes(256 * 1024, i + 1))
    }
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: src })
    await scanDone

    await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
      (f) => Array.isArray(f?.entries) && f.entries.length === 12)

    // Start the mirror (fire-and-forget scan) then unmount almost immediately —
    // while the materialize pass over 12 files is still in flight.
    const dest = mkTmpDir(t)
    await B.request('foreign-folder:mount', { spaceId, ownerKey: aKey, shareId: share.id, mountPath: dest })
    await new Promise((r) => setTimeout(r, 250))
    await B.request('foreign-folder:unmount', { spaceId, shareId: share.id })

    // Sync must halt: the destination file count stabilises (not climbing to 12).
    await new Promise((r) => setTimeout(r, 2000))
    const a = countFiles(dest)
    await new Promise((r) => setTimeout(r, 2000))
    const b = countFiles(dest)
    t.is(a, b, 'mirror stopped — destination is no longer growing after unmount')

    // And the mount stays gone — a trailing save must not recreate it.
    const mounts = await B.request('foreign-folder:list-all')
    t.absent(mounts.some((m) => m.shareId === share.id), 'unmounted mirror was not resurrected')
  })
