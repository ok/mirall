import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Negative / gating: with overlay OFF, the Folder Share control must NOT render the
// "In place" segment. Overlay is the only non-eager mode, so with it off the control has
// nothing to offer and is hidden entirely (Eager is implicit). Both overlay and inPlaceFiles
// are turned off because overlayEnabled is overlay||inPlaceFiles; leaving in-place on would
// keep the overlay backend (and the segment) available. This guards the feature gate. Single
// instance, no peer — only the modal is inspected.
export default async function s67 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1, flags: { overlay: false, inPlaceFiles: false } })

  const ownDir = path.join(workDir('own-'), 'NoOverlay')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'doc.txt'), 'no overlay here')

  try {
    await r.ok('with overlay off, the "In place" segment is hidden', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openAddFolderModal(ownDir)
      assert(!(await A.hasText('In place')), 'overlay "In place" segment shown despite its flag being off')
      await A.shot('s67-A-no-overlay-segment', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
