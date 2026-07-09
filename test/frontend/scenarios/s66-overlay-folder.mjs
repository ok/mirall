import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Overlay ("In place") publishing through the UI. Overlay is the only content mode, so
// the Add Folder modal has no mode picker — a share always publishes in place: no second
// copy is imported, the catalog replicates so B sees the file, and B fetches it by content
// hash straight from A onto disk.
export default async function s66 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'InPlace')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'report.txt'), 'overlay contents in place')

  try {
    await r.ok('A shares "InPlace" as an overlay folder; B sees it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      // No mode picker — sharing publishes in place via overlay (no second copy imported).
      await A.addOwnedFolder(ownDir)
      await A.waitText('InPlace', 20000)
      await B.waitText('InPlace', 60000)
      await A.shot('s66-A-shared-in-place', runDir)
    })
    // The overlay owner's own files report 'synced' (like eager/deferred owners),
    // so the badge must read "Shared by you", not "On your device".
    await r.ok('overlay owner sees "Shared by you" on their files', async () => {
      await A.openFolder('InPlace')
      await A.waitText('report.txt', 20000)
      assert(await A.hasText('Shared by you'), 'overlay owned file not labelled "Shared by you"')
      assert(!(await A.hasText('On your device')), 'overlay owned file wrongly labelled "On your device"')
      await A.back()
    })
    await r.ok('B sees the file as Available (from the catalog, no bytes imported)', async () => {
      await B.openFolder('InPlace')
      await B.waitText('report.txt', 20000)
      assert(await B.hasText('Available'), 'overlay file not shown as available')
    })
    await r.ok('B downloads in place → fetched by content hash, bytes land', async () => {
      await B.click({ role: 'button', name: 'Download' })
      const landed = path.join(B.downloadFolder, 'report.txt')
      await waitFor(() => existsSync(landed), 90000, 'report.txt fetched via overlay')
      assert(readFileSync(landed, 'utf8') === 'overlay contents in place', 'overlay bytes match the source')
      await B.waitText('On your device', 20000)
      await B.shot('s66-B-downloaded-in-place', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
