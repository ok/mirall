import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P0 / G3 — the owner creates a nested subfolder with a file inside a shared
// folder. The nested path must replicate (slash-keyed), show in the peer's
// folder view, and materialize at the right nested path on a mirror's disk via
// mkdir -p. Nesting is exactly where path-handling bugs hide.
export default async function s28 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Media')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'root.txt'), 'top level')

  try {
    await r.ok('launch + connect + A shares "Media", B mirrors', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Media', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(() => existsSync(path.join(mirrorDir, 'root.txt')), 60000, 'root file on mirror')
    })
    await r.ok('A creates a nested subfolder with a file; it materializes nested on the mirror', async () => {
      mkdirSync(path.join(ownDir, 'trips', '2024'), { recursive: true })
      writeFileSync(path.join(ownDir, 'trips', '2024', 'lake.txt'), 'nested content')
      await waitFor(() => existsSync(path.join(mirrorDir, 'trips', '2024', 'lake.txt')), 60000,
        'nested file materialized at the right depth')
      assert(existsSync(path.join(mirrorDir, 'root.txt')), 'root file untouched')
      await B.shot('s28-B-mirror-nested', runDir)
    })
    await r.ok('the nested file shows in B’s folder view', async () => {
      await B.openFolder('Media')
      // FolderView is a collapsible tree (s103): top-level folders open by default, deeper
      // ones stay collapsed, and leaves render their basename — so the replicated nesting
      // shows as a "trips" row containing a "2024" row, and the leaf appears once it's opened.
      await B.waitText('trips', 20000)
      assert(await B.hasText('2024'), 'the nested subfolder replicated as its own tree level')
      await B.click({ role: 'button', name: '2024' })
      await B.waitText('lake.txt', 20000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
