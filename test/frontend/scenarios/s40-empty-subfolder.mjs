import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P2 / G15 — known limitation: Hyperdrive is path-keyed, so empty directories
// have no entry and don't replicate. Sharing a folder that contains an empty
// subfolder must degrade gracefully (the file syncs, the empty subfolder simply
// doesn't appear on the mirror, no crash) — and when the first file lands in
// that subfolder, the directory materializes implicitly.
export default async function s40 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Mixed')
  const mirrorDir = workDir('mirror-')
  mkdirSync(path.join(ownDir, 'placeholder'), { recursive: true })   // empty subfolder
  writeFileSync(path.join(ownDir, 'doc.txt'), 'has content')

  try {
    await r.ok('A shares a folder containing a file and an empty subfolder; B mirrors', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Mixed', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'doc.txt')), 60000, 'the real file mirrored')
    })
    await r.ok('the empty subfolder does not replicate (graceful, no crash)', async () => {
      await new Promise((res) => setTimeout(res, 3000))
      assert(!existsSync(path.join(mirrorDir, 'placeholder')), 'empty subfolder absent on mirror')
      await B.openFolder('Mixed')
      await B.waitText('doc.txt', 20000)                 // folder view renders fine
    })
    await r.ok('adding the first file to that subfolder materializes it', async () => {
      writeFileSync(path.join(ownDir, 'placeholder', 'now.txt'), 'first nested file')
      await waitFor(() => existsSync(path.join(mirrorDir, 'placeholder', 'now.txt')), 60000,
        'subfolder materializes once it holds a file')
      await B.shot('s40-B-empty-then-filled', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
