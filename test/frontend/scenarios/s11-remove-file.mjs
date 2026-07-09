import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Unshare a loose file via the FileCard "Unshare from Space" action and the
// RemoveFileModal confirm; the tombstone removes it for the owner and propagates
// to the peer.
export default async function s11 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const file = path.join(workDir('file-'), 'draft.txt')
  writeFileSync(file, 'a file to be unshared')

  try {
    await r.ok('launch + connect + share', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(file)
      await B.waitText('draft.txt', 60000)
    })
    await r.ok('A unshares the file via the RemoveFileModal', async () => {
      await A.click({ role: 'button', name: 'Unshare from Space', last: true })
      await A.waitText('Remove', 8000)
      await A.click({ role: 'button', name: 'Remove File', last: true })
      await waitFor(async () => !(await A.hasText('draft.txt')), 15000, 'file gone for owner')
      await A.shot('s11-A-removed', runDir)
    })
    await r.ok('the removal propagates to the peer', async () => {
      await waitFor(async () => !(await B.hasText('draft.txt')), 60000, 'file gone for peer')
      await B.shot('s11-B-tombstoned', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
