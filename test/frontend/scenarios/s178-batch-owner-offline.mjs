import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// A browse folder whose owner is offline: every file reads Not available and its own Download is
// disabled, yet select-all takes all of them and the strip offers Download N. The request is kept:
// a toast says the files will come once the owner is back, the rows read Owner offline, the strip
// says they are paused and Cancel All can still stop them, and the files land when the owner returns.
const NAMES = ['brief.pdf', 'notes.txt']

export default async function s178({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  for (const name of NAMES) writeFileSync(path.join(ownDir, name), name)

  try {
    await r.ok('B opens the folder, then its owner goes offline', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Archive', 60000)
      await B.openFolder('Archive')
      await B.waitText('notes.txt', 30000)
      await A.quit()
      await B.waitText('Not available', 90000)
    })

    await r.ok('select-all takes every offline file and the strip offers to download them', async () => {
      await waitFor(() => B.has({ role: 'checkbox', name: 'Select all 2 files' }), 20000, 'the top box counts the offline files')
      await B.click({ role: 'checkbox', name: 'Select all 2 files' })
      await B.waitText('2 selected', 20000)
      assert(await B.has({ role: 'button', name: `Download 2 to ${path.basename(B.downloadFolder)}` }), 'Download counts both offline files')
      await B.shot('s178-selected-offline', runDir)
    })

    await r.ok('the request is kept: a toast says so, the rows wait on the owner, the strip offers Cancel All', async () => {
      await B.downloadSelected(2)
      await B.waitText('will download once their owner is online', 20000)
      await B.waitText('Owner offline', 30000)
      await B.waitText('2 downloads paused', 20000)
      assert(!(await B.hasText('Downloading 2 files')), 'the strip does not claim a download while nothing moves')
      assert(await B.has({ role: 'button', name: 'Cancel All' }), 'paused downloads can still be cancelled together')
      await B.shot('s178-kept', runDir)
    })

    await r.ok('the files land in their folder when the owner is back', async () => {
      await A.launch({ onboard: false })
      await waitFor(() => NAMES.every((n) => existsSync(path.join(B.downloadFolder, 'Archive', n))), 120000, 'both files landed under the folder')
      await B.waitText('On your device', 30000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
