import { mkdirSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

export default async function s4({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const srcDir = workDir('src-')
  const srcFile = path.join(srcDir, 'report.txt')
  writeFileSync(srcFile, 'SHARED')

  try {
    await r.ok('launch A + B', async () => {
      await A.launch()
      await B.launch()
    })
    await r.ok('connect in space', async () => {
      await connectInSpace(A, B, { name: 'Aurora' })
    })
    await r.ok('A adds report.txt (native file picker)', async () => {
      await A.addFile(srcFile)
      await A.waitText('report.txt')
    })
    await r.ok('B sees report.txt as Available', async () => {
      await B.waitText('report.txt', 60000)
    })
    await r.ok('FIX-3: pre-existing download is not overwritten', async () => {
      // Seed a same-named file in B's download folder, then download.
      writeFileSync(path.join(B.downloadFolder, 'report.txt'), 'ORIGINAL')
      await B.click({ role: 'button', name: 'Download' })
      await waitFor(() => existsSync(path.join(B.downloadFolder, 'report (1).txt')), 60000, 'report (1).txt')
      assert(readFileSync(path.join(B.downloadFolder, 'report.txt'), 'utf8') === 'ORIGINAL', 'original was overwritten')
      assert(readFileSync(path.join(B.downloadFolder, 'report (1).txt'), 'utf8') === 'SHARED', 'shared copy missing/wrong')
      await B.shot('s4-downloaded', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
