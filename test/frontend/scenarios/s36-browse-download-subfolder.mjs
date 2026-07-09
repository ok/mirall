import { mkdirSync, writeFileSync, existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// P1 / G11 — a browse-only peer (no mirror) downloads a single file that lives
// in a subfolder, on demand, to the global download folder. The flat case is
// covered by s10; nesting exercises the nested drive-path → download path.
export default async function s36 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(path.join(ownDir, 'reports', '2024'), { recursive: true })
  writeFileSync(path.join(ownDir, 'reports', '2024', 'q4.txt'), 'quarterly numbers')

  try {
    await r.ok('A shares "Archive"; B sees it (browse-only, no mirror)', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Archive', 60000)
    })
    await r.ok('B opens the folder and sees the nested file as Available', async () => {
      await B.openFolder('Archive')
      await B.waitText('2024', 20000) // reports is top-level → open by default, its subfolder row shows
      await B.click({ role: 'button', name: '2024' }) // 2024 is nested → collapsed by default
      await B.waitText('q4.txt', 20000)
      assert(await B.hasText('Available'), 'nested file shown as available to download')
    })
    await r.ok('B downloads the nested file → it lands in the download folder', async () => {
      await B.click({ role: 'button', name: 'Download' })
      const landed = path.join(B.downloadFolder, 'q4.txt')
      await waitFor(() => existsSync(landed), 60000, 'q4.txt downloaded')
      assert(readFileSync(landed, 'utf8') === 'quarterly numbers', 'downloaded bytes match')
      await B.waitText('On your device', 20000)
      await B.shot('s36-B-downloaded-nested', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
