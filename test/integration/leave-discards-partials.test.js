import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { registerSpaceLeave } from '../../src/worker/ipc/space-leave.js'
import { forgetSpaceDownloadRoot, listDownloadRoots, noteLandedFolders, setRecentDownloadFolders, setSpaceDownloadRoot } from '../../src/shared/core/paths.js'
import { recordPending, listPending } from '../../src/shared/transfer/pending-transfers.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

const quiet = { debug() {}, info() {}, warn() {}, error() {} }

const partialOf = (finalPath) => finalPath + '.mirall.part'

async function pendingAt(spaceId, folder, name) {
  const finalPath = path.join(folder, name)
  fs.writeFileSync(partialOf(finalPath), 'half')
  await recordPending(spaceId, '/' + name, { finalPath, destDir: folder, bytesTransferred: 4, inPlace: true, shareId: LOOSE_SHARE_ID, relPath: name, ownerKey: 'o'.repeat(64) })
  return finalPath
}

// REGRESSION (FIX-DLTO-R6: leaving a space skipped every flat partial in a folder that was still a
// download root — a folder a download landed in stays one for the session — and the next boot reads
// only the roots it can name, so a left space's multi-GB partial in a folder that had dropped out of
// the recent list was never reclaimed.)
test('REGRESSION (FIX-DLTO-R6: leaving a space discards its partials unless another download still holds the path)', async (t) => {
  const { fake, root, tmpDir } = await freshPeer(t)
  const left = await createSpace('Left')
  const kept = await createSpace('Kept')
  const folder = tmpDir('dl-left')
  setSpaceDownloadRoot(left.spaceId, folder)
  setRecentDownloadFolders([folder])
  noteLandedFolders([folder])
  const own = await pendingAt(left.spaceId, folder, 'big.bin')
  const shared = await pendingAt(left.spaceId, folder, 'shared.bin')
  await recordPending(kept.spaceId, '/shared.bin', { finalPath: shared, destDir: folder, bytesTransferred: 4, inPlace: true, shareId: LOOSE_SHARE_ID, relPath: 'shared.bin', ownerKey: 'p'.repeat(64) })
  registerSpaceLeave(fake.ipc, { log: quiet, mounts: root.mounts, overlayBackend: root.overlayBackend, discardPendingSpace: async () => {}, dropSpaceDownloadRoot: forgetSpaceDownloadRoot })

  t.ok(listDownloadRoots().includes(folder), 'precondition: the folder is a download root while the space leaves')
  t.alike(await fake.call('space:leave', { spaceId: left.spaceId }), { ok: true })

  t.absent(fs.existsSync(partialOf(own)), 'the left space\'s partial goes with its row')
  t.ok(fs.existsSync(partialOf(shared)), 'a partial another space\'s row still names survives')
  t.alike((await listPending()).map((row) => row.spaceId), [kept.spaceId], 'only the kept space\'s row remains')
})
