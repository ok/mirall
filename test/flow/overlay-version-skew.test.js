import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// R14 — version/flag skew. An overlay share replicates to a peer that does NOT
// support overlay (a pre-overlay build, or one with the flag off). getContentBackend
// returns the UNSUPPORTED sentinel there, and the worker must DEGRADE GRACEFULLY:
// the share lists empty and a read is refused — it must never fall through to the
// eager (drive) path, which would mis-read an overlay share (it holds no drive
// bytes) as broken/empty-with-errors. The owner side stays fully functional.
test('R14: an overlay share seen by a peer without overlay support degrades, never eager-misroutes',
  { timeout: scaled(150000) }, async (t) => {
    const bootstrap = await localTestnet(t)
    const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkTmpDir(t), flags: { overlayEnabled: true } })
    const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: { overlayEnabled: false } }) // overlay OFF
    const spaceId = await connectInSpace(t, A, B)
    const aKey = (await A.request('profile:get')).publicKey

    const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
    const folder = mkTmpDir(t)
    fs.writeFileSync(path.join(folder, 'a.bin'), patternedBytes(64 * 1024, 7))
    const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
    await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
    await scanDone

    // B replicates the share record (proves it SEES the overlay share)…
    await B.until('share:list', { spaceId }, (l) => Array.isArray(l) && l.some((s) => s.id === share.id),
      { ms: scaled(60000) })

    // …but, lacking overlay support, it lists the share EMPTY (UNSUPPORTED → []),
    // not as a broken eager drive. No crash, no mis-route.
    const files = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    t.alike(files.entries, [], 'unsupported overlay share lists empty — not eager-routed, not crashed')

    // A read of an unsupported file is refused outright (not a hung eager drive read).
    await t.exception(
      B.request('share:read-file', { spaceId, ownerKey: aKey, shareId: share.id, relPath: 'a.bin' }),
      'reading an unsupported overlay file is refused, not attempted as a drive read',
    )

    // folder-info degrades to an empty summary rather than throwing / drive-opening.
    const info = await B.request('share:folder-info', { spaceId, ownerKey: aKey, shareId: share.id })
    t.is(info.fileCount, 0, 'unsupported share reports an empty folder-info, no drive blobs')

    // The owner (overlay on) still lists + serves its own files normally.
    const own = await A.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
    t.ok(own.entries.some((e) => e.relPath === 'a.bin'), 'owner still lists its own overlay files')
  })
