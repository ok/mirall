import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Per-file actions on a loose file (FileCard in the space view): a peer downloads
// it to completion and then has a Reveal affordance. The Download / Reveal
// controls are icon-only and must carry accessible names. Pause/resume/retry are
// transfer-timing dependent and covered at the flow/integration layers (the
// testing discipline says not to force flaky UI timing assertions).
export default async function s10 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const file = path.join(workDir('file-'), 'report.txt')
  writeFileSync(file, 'shared loose file contents')

  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })
    await r.ok('A shares a loose file; B sees it as available', async () => {
      await A.addFile(file)
      await B.waitText('report.txt', 60000)
      await B.waitText('Available', 60000)
    })
    await r.ok('B downloads the file to completion', async () => {
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('On your device', 60000)
      await B.shot('s10-B-downloaded', runDir)
    })
    await r.ok('B now has a Reveal in Folder action for the downloaded file', async () => {
      await waitFor(async () => B.has({ role: 'button', name: 'Reveal in Folder' }), 10000, 'reveal affordance')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
