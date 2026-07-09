import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// FIX-141 (UI) — a folder with more files than the row cap renders only the first N rows, and a
// role=status banner tells the user "Showing the first N of M files." so the truncation is never
// silent. The cap is shrunk via MIRALL_LIST_FILES_CAP so a handful of files trips it; the true
// total comes from the worker's one-pass count (folder header still shows the real count).
//
// Pairs with a VoiceOver spot-check (the banner is a pre-mounted aria-live region) and the
// data-layer fold + deriveFolderInfo unit tests.
export default async function s78 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  process.env.MIRALL_LIST_FILES_CAP = '3'
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Big')
  mkdirSync(ownDir, { recursive: true })
  const N = 8 // > cap (3)
  for (let i = 0; i < N; i++) writeFileSync(path.join(ownDir, 'f' + String(i).padStart(2, '0') + '.txt'), 'x'.repeat(64))

  try {
    await r.ok('A shares a folder with more files than the cap, then opens it', async () => {
      await A.launch()
      // Add-Folder (cmd+shift+u) is registered only in space-view, so enter a space first.
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Big', 60000)
      await A.openFolder('Big')
    })
    await r.ok('the listing is capped and the "first N of M" banner announces the truncation', async () => {
      await A.waitText('f00.txt', 30000)
      // The header still reports the TRUE total (8 files), and the truncation banner is shown.
      assert(await A.hasText('8'), 'the folder header shows the true total (8), not the capped 3')
      assert(await A.hasText('Showing the first 3 of 8 files'), 'the truncation banner names shown-of-total')
      await A.shot('s78-A-truncated', runDir)
    })
  } catch {} finally {
    delete process.env.MIRALL_LIST_FILES_CAP
  }
  return { pass: r.summary(), instances: [A] }
}
