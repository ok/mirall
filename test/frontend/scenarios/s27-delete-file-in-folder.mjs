import { mkdirSync, writeFileSync, existsSync, rmSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P0 / G2 — the owner deletes one file from a shared folder. It must disappear
// for the peer and be removed from the mirror, while the folder's other files
// stay (the deletion must not be mistaken for the "folder emptied" transient).
export default async function s27 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'keep.txt'), 'stays')
  writeFileSync(path.join(ownDir, 'remove.txt'), 'goes')

  try {
    await r.ok('launch + connect + A shares "Reports", B mirrors both files', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Reports', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'keep.txt')) && existsSync(path.join(mirrorDir, 'remove.txt')),
        60000, 'both files on mirror')
    })
    await r.ok('A deletes remove.txt; it leaves the mirror, keep.txt stays', async () => {
      rmSync(path.join(ownDir, 'remove.txt'))
      await waitFor(() => !existsSync(path.join(mirrorDir, 'remove.txt')), 60000, 'remove.txt gone from mirror')
      assert(existsSync(path.join(mirrorDir, 'keep.txt')), 'keep.txt still on mirror')
      await B.shot('s27-B-mirror-after-delete', runDir)
    })
    await r.ok('the deletion shows in B’s folder view', async () => {
      await B.openFolder('Reports')
      await waitFor(async () => !(await B.hasText('remove.txt')), 20000, 'remove.txt no longer listed')
      assert(await B.hasText('keep.txt'), 'keep.txt still listed')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
