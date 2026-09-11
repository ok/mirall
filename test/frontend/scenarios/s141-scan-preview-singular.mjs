import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (FIX-PLURAL-SUFFIX) — the Add-Folder preview counts in the singular. A folder holding
// exactly one file reads "Upload 1 file"; naming i18next's `_other` suffix in the key pins the
// plural form for every count, so the same card read "Upload 1 files".
//
// hasText is a case-folded WHOLE-WINDOW substring match, so the singular alone would also match
// inside the plural. The plural string has to be asserted ABSENT for this to mean anything.
export default async function s141({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Solo')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'only.txt'), 'x'.repeat(64))

  try {
    await r.ok('A opens the Add Folder preview on a one-file folder', async () => {
      await A.launch()
      // Add-Folder (cmd+shift+u) is registered only in space-view, so enter a space first.
      await A.createSpaceOnly('Aurora')
      await A.openAddFolderPreview(ownDir)
    })
    await r.ok('the summary card counts in the singular', async () => {
      await A.waitText('Upload 1 file', 30000)
      assert(!(await A.hasText('Upload 1 files')), 'the plural form is NOT used at count 1')
      await A.shot('s141-A-scan-preview-singular', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
