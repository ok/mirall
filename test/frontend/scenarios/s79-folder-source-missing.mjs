import { mkdirSync, writeFileSync, renameSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-EDA-…/F2): the "source missing" banner must appear and clear WHILE the
// owner's FolderView stays open. It used to derive from the frozen navigation snapshot
// (the only live subscriber unmounted with SpaceView), so a mount root vanishing mid-view
// never rendered until the user navigated away and back.
export default async function s79 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const base = workDir('own-')
  const ownDir = path.join(base, 'Photos')
  const movedDir = path.join(workDir('moved-'), 'Photos')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'a.txt'), 'AAA')

  try {
    await r.ok('A shares a folder and opens its own folder view', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Photos', 20000)
      await A.openFolder('Photos')
      await A.waitText('a.txt', 20000)
    })

    await r.ok('the source vanishing surfaces the banner while the view stays open', async () => {
      renameSync(ownDir, movedDir)
      await A.waitText('Source folder moved', 90000)
      await A.shot('s79-banner', runDir)
    })

    await r.ok('restoring the source clears the banner without leaving the view', async () => {
      renameSync(movedDir, ownDir)
      await waitFor(async () => !(await A.hasText('Source folder moved')), 90000, 'banner cleared in place')
      await A.shot('s79-cleared', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
