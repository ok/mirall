import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// FIX-141 / FIX-360 (UI) — a folder holding more files than a share may contain renders only the
// first N rows, and a role=status banner names the true total, the limit, and how many are listed —
// so the truncation is never silent, and the user is told the files still sync. The cap is shrunk
// via MIRALL_LIST_FILES_CAP so a handful of files trips it; the true total comes from the worker's
// one-pass count (the folder header still shows the real count).
//
// A folder over the limit can no longer be CREATED (s104 covers the refusal) — this is the residual
// case: a share that GREW past the limit, which keeps syncing and says so.
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
    await r.ok('the listing is capped and the banner announces it, naming the limit', async () => {
      await A.waitText('f00.txt', 30000)
      // The header still reports the TRUE total (8 files), and the truncation banner is shown.
      assert(await A.hasText('8'), 'the folder header shows the true total (8), not the capped 3')
      assert(await A.hasText('above the 3-file limit'), 'the banner names the true total and the limit it exceeds')
      assert(await A.hasText('still syncing'), 'and says every file still syncs — truncation is a LISTING bound, not a sync bound')
      await A.shot('s78-A-truncated', runDir)
    })
  } catch {} finally {
    delete process.env.MIRALL_LIST_FILES_CAP
  }
  return { pass: r.summary(), instances: [A] }
}
