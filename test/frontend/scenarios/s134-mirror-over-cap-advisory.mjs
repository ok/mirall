import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// FIX-PI6-2 (UI) — mirroring a share with more files than the display cap WARNS, where adding an
// over-limit folder of your own REFUSES (s104). The difference is the whole point: a mount creates
// no share, so the admission gate is not this flow's to enforce — but the listing ceiling is real,
// and the folder screen already says so afterwards (s78). This is the same news delivered before
// the user commits, with the primary action still enabled.
//
// The cap is shrunk via MIRALL_LIST_FILES_CAP so a handful of files trips it.
export default async function s134 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  process.env.MIRALL_LIST_FILES_CAP = '3'
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Big')
  mkdirSync(ownDir, { recursive: true })
  const N = 8 // > cap (3)
  for (let i = 0; i < N; i++) writeFileSync(path.join(ownDir, 'f' + String(i).padStart(2, '0') + '.txt'), 'x'.repeat(64))
  const mirrorDir = workDir('mirror-')

  try {
    await r.ok('launch + connect + A shares a folder with more files than the cap', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Big', 60000)
    })

    await r.ok('B\'s mirror preview warns about the short list, and lets him proceed anyway', async () => {
      await B.openMirrorPreview(mirrorDir)
      await B.waitText('above the 3-file limit', 30000)
      assert(await B.hasText('has 8 files'), 'the advisory names the TRUE remote count (8), not the capped 3')
      assert(await B.hasText('only show the first'), 'and says what is actually capped — the list, not the sync')
      assert(
        !(await B.isDisabled({ role: 'button', name: 'Start Mirroring', last: true })),
        'the confirm stays ENABLED — this is a warning, not a refusal (contrast s104)',
      )
      await B.shot('s134-B-mirror-over-cap-advisory', runDir)
    })
  } catch {} finally {
    delete process.env.MIRALL_LIST_FILES_CAP
  }
  return { pass: r.summary(), instances: [A, B] }
}
