import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, waitForFile } from '../helpers/fixtures.js'

// CRIT-7 (flow) — a mirror is owner-authoritative. If the user edits a file inside
// their own mirror, the next materialize tick notices the on-disk hash no longer
// matches the owner's drive hash and re-downloads, reverting the local edit. This
// documents (and guards) that local edits to mirrored files are NOT preserved —
// so the UI must steer users away from editing inside a mirror.
test('a local edit to a mirrored file is reverted to the owner version on the next tick', { timeout: 150000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'note.txt'), 'owner-authoritative-v1')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  await waitForFile(path.join(mirrorDir, 'note.txt'), { present: true })

  // The user tampers with the mirrored copy locally (no owner-side change).
  const noteOnB = path.join(mirrorDir, 'note.txt')
  fs.writeFileSync(noteOnB, 'tampered locally by Bob')

  // Wake B's tick by having the owner replicate an unrelated new file; the same
  // tick re-checks note.txt, sees the hash mismatch, and re-downloads it.
  fs.writeFileSync(path.join(folder, 'wake.txt'), 'tick trigger')
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'add', relPath: 'wake.txt', absPath: path.join(folder, 'wake.txt') })
  await waitForFile(path.join(mirrorDir, 'wake.txt'), { present: true, ms: 120000 })

  // The local edit was overwritten back to the owner's authoritative content.
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    () => fs.readFileSync(noteOnB, 'utf8') === 'owner-authoritative-v1', { ms: 60000 })
  t.is(fs.readFileSync(noteOnB, 'utf8'), 'owner-authoritative-v1', 'local edit reverted to the owner version')
})
