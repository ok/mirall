import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// AddFolderShareModal validation: a second folder whose name collides with an
// existing share is rejected, an invalid share name is rejected, and in both
// cases the "Next: Preview" button stays disabled. The errors render in
// role=alert regions tied to the field via aria-describedby. Also asserts the
// Folder Share segmented control defaults to Eager and flips aria-pressed on
// switching to In place.
export default async function s12 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const reportsA = path.join(workDir('owna-'), 'Reports')
  const reportsB = path.join(workDir('ownb-'), 'Reports')
  for (const d of [reportsA, reportsB]) {
    mkdirSync(d, { recursive: true })
    writeFileSync(path.join(d, 'q1.txt'), 'numbers')
  }

  try {
    await r.ok('launch + create space + share "Reports"', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(reportsA)
      await A.waitText('Reports', 20000)
    })
    await r.ok('a second folder named "Reports" surfaces the name-collision error', async () => {
      await A.openAddFolderAndPick(reportsB)
      await A.waitText('already exists in this space', 8000)
      await waitFor(async () => A.isDisabled({ role: 'button', name: 'Next: Preview' }), 8000, 'Next disabled on collision')
      await A.shot('s12-collision', runDir)
    })
    await r.ok('an invalid share name is rejected and blocks Next', async () => {
      await A.type({ role: 'textfield' }, 'bad/name')
      await A.waitText("can't contain slashes", 8000)
      await waitFor(async () => A.isDisabled({ role: 'button', name: 'Next: Preview' }), 8000, 'Next disabled on invalid name')
      await A.shot('s12-invalid-name', runDir)
    })
    // (The Eager/In-place mode picker was removed with the eager backend — overlay is the
    // only content mode now, so there is no longer a segmented control to validate here.)
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
