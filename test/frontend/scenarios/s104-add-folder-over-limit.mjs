import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// FIX-360 (UI) — the share file limit is stated BEFORE the user commits. A folder with more files
// than a share may hold is refused in the Add-Folder preview step, naming both the actual count and
// the limit, with the confirm button genuinely disabled. Previously such a folder was accepted,
// published, and then silently listed short — the user only discovered the limit afterwards, from a
// banner. The limit is shrunk via MIRALL_MAX_FILES_PER_SHARE so a handful of files trips it.
//
// The refusal is a role=alert that takes focus, so it is announced rather than merely painted.
export default async function s104 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  process.env.MIRALL_MAX_FILES_PER_SHARE = '5'
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'TooBig')
  mkdirSync(ownDir, { recursive: true })
  const N = 8 // > limit (5)
  for (let i = 0; i < N; i++) writeFileSync(path.join(ownDir, 'f' + String(i).padStart(2, '0') + '.txt'), 'x'.repeat(64))

  try {
    await r.ok('A opens Add Folder on a folder with more files than the limit', async () => {
      await A.launch()
      // Add-Folder (cmd+shift+u) is registered only in space-view, so enter a space first.
      await A.createSpaceOnly('Aurora')
      await A.openAddFolderPreview(ownDir)
    })
    await r.ok('the preview refuses it, naming the count and the limit, and disables the confirm', async () => {
      await A.waitText('above the 5-file limit', 30000)
      assert(await A.hasText('8'), 'the refusal names the ACTUAL file count (8)')
      assert(await A.hasText('above the 5-file limit'), 'and the limit it exceeds')
      assert(
        await A.isDisabled({ role: 'button', name: 'Add Folder', last: true }),
        'the confirm button is DISABLED — the folder cannot be shared, not merely warned about',
      )
      await A.shot('s104-A-add-folder-over-limit', runDir)
    })
  } catch {} finally {
    delete process.env.MIRALL_MAX_FILES_PER_SHARE
  }
  return { pass: r.summary(), instances: [A] }
}
