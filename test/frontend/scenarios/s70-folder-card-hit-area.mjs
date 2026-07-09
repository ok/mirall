import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Folder card click target: the card became fully clickable via a full-bleed nav
// overlay, with the action menu lifted above it. Both must still work through the
// rendered UI. The whole-card geometry itself (padding strips now navigate) is
// asserted in the real-Chromium layout harness (run-sharecard.mjs) — agent-desktop
// clicks element centres and cannot address the former dead padding strips.
export default async function s70 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Photos')
  mkdirSync(ownDir)
  writeFileSync(path.join(ownDir, 'a.txt'), 'AAA')

  try {
    await r.ok('launch + create space + share a folder', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Photos', 20000)
      await A.shot('s70-folder-card', runDir)
    })
    await r.ok('the action menu is reachable above the nav overlay', async () => {
      await A.click({ name: 'More', last: true })
      await A.waitText('Delete Folder', 8000)
      await A.press('escape')
    })
    await r.ok('clicking the folder card navigates into it', async () => {
      await A.openFolder('Photos')
      await A.waitText('a.txt', 20000)
      await A.back()
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
