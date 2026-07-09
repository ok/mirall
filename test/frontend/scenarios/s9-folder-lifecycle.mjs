import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Folder lifecycle through the UI: an owner shares a folder, a peer sees it,
// then the owner DELETES it via the card menu + DeleteFolderShareModal. The
// share must disappear for both peers. This exercises the delete dialog (a new
// renderer surface) and its accessibility — agent-desktop can only drive the
// "Delete Folder" menu item and confirm button because they carry accessible
// names/roles; if they didn't, this scenario could not target them.
//
// Relocate's guarantee (hash-match → no mirror churn) is asserted at the
// backend layers (test/flow/relocate, test/integration/owned-folder-publish);
// driving the native re-pick after inducing a mount-point-gone state is the
// kind of flaky UI assertion the testing discipline says to avoid.
export default async function s9({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  mkdirSync(ownDir)
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')
  writeFileSync(path.join(ownDir, 'q2.txt'), 'more numbers')

  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })
    await r.ok('A shares "Reports", B sees it', async () => {
      await A.addOwnedFolder(ownDir)
      await A.waitText('Reports', 20000)
      await B.waitText('Reports', 60000)
      await A.shot('s9-A-shared', runDir)
    })
    await r.ok('A deletes the folder via the card menu + confirm dialog', async () => {
      await A.deleteShare()
      await waitFor(async () => !(await A.hasText('Reports')), 20000, 'folder removed from owner view')
      await A.shot('s9-A-deleted', runDir)
    })
    await r.ok('the tombstone propagates: the folder disappears for the peer', async () => {
      await waitFor(async () => !(await B.hasText('Reports')), 60000, 'folder removed from peer view')
      await B.shot('s9-B-tombstoned', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
