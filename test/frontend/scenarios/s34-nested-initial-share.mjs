import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P1 / G9 — the initial share of a realistic, non-flat folder: multiple files
// across several nested subfolders. The whole tree must replicate and
// materialize at the right depths (the existing owner-folder scenarios use only
// 1–2 flat files). Exact preview counts are covered at test/integration/preview-scan.
export default async function s34 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Project')
  const mirrorDir = workDir('mirror-')
  const tree = ['readme.md', 'src/index.js', 'src/util/helpers.js', 'docs/guide.md']
  mkdirSync(path.join(ownDir, 'src', 'util'), { recursive: true })
  mkdirSync(path.join(ownDir, 'docs'), { recursive: true })
  for (const rel of tree) writeFileSync(path.join(ownDir, ...rel.split('/')), `content of ${rel}`)

  try {
    await r.ok('launch + connect + A shares the nested "Project" tree, B mirrors', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Project', 60000)
      await B.mirrorShare(mirrorDir)
    })
    await r.ok('the entire nested tree materializes at the right depths', async () => {
      for (const rel of tree) {
        await waitFor(() => existsSync(path.join(mirrorDir, ...rel.split('/'))), 90000, `${rel} on mirror`)
      }
      await B.shot('s34-B-mirror-tree', runDir)
    })
    await r.ok('the nested files show in B’s folder view', async () => {
      await B.openFolder('Project')
      await B.waitText('index.js', 20000) // src is top-level → open by default, so its file shows
      assert(await B.hasText('guide.md'), 'a file in another top-level subfolder is listed')
      await B.click({ role: 'button', name: 'util' }) // util is nested → collapsed by default
      await B.waitText('helpers.js', 10000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
