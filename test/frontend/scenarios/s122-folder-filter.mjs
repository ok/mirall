import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText, flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// The folder screen had no way to find a file: no search, no filter, in a listing that admits 5,000
// of them. The controls row now sits pinned on the list with a filter and Expand all, and the filter
// is client-side over rows already loaded — which is also why it has to be proven not to disturb the
// tree it filters: clearing it must restore exactly the expansion the user had.
// No role in the selector: an <input type="search"> lands as a search field rather than a plain
// text field on macOS, and findNode matches the aria-label through `description` either way.
const FILTER = { name: 'Filter files in this folder' }

export default async function s122 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(path.join(ownDir, 'Ninja Tune'), { recursive: true })
  mkdirSync(path.join(ownDir, 'Boiler Room'), { recursive: true })
  writeFileSync(path.join(ownDir, 'Ninja Tune', 'kruder-dorfmeister.mp3'), 'a')
  writeFileSync(path.join(ownDir, 'Ninja Tune', 'bonobo.mp3'), 'b')
  writeFileSync(path.join(ownDir, 'Boiler Room', 'monika-kruse.mp3'), 'c')
  writeFileSync(path.join(ownDir, 'readme.txt'), 'd')

  try {
    await r.ok('the folder screen opens on a controls row, not a heading', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Archive', 60000)
      await A.openFolder('Archive')
      await A.waitText('readme.txt', 60000)
      // NOT a text assertion on "files in this folder": the filter's own aria-label contains that
      // phrase, and allText folds descriptions in. The heading was an <h2>, so ask the AX tree for
      // headings instead — that is the thing that actually went away.
      const tree = await A.snap()
      const headings = flatten(tree).filter((n) => n.role === 'heading')
      assert(!headings.some((h) => /^files in this folder/i.test(h.name)), 'the duplicated heading is gone')
      const text = allText(tree)
      assert(/people/i.test(text) && /folder/i.test(text), 'both tiles are on screen')
      await A.shot('s122-A-controls-row', runDir)
    })

    await r.ok('the filter narrows the list and says how far it narrowed it', async () => {
      // Addressable by role+name IS the accessibility proof: a control the AX tree cannot name is
      // an a11y gap in the control, not a gap in the test.
      await A.type(FILTER, 'kru')
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /kruder-dorfmeister\.mp3/i.test(text) && !/bonobo\.mp3/i.test(text)
      }, 20000, 'only the matching rows survive')
      const text = allText(await A.snap())
      assert(/monika-kruse\.mp3/i.test(text), 'a match in another branch is revealed too')
      assert(/2 of 4/i.test(text), 'the count reports the whole folder, not the filtered set')
      await A.shot('s122-A-filtered', runDir)
    })

    await r.ok('no match says so without emptying the tiles', async () => {
      await A.type(FILTER, 'xyzzy')
      await A.waitText('No files match', 20000)
      const text = allText(await A.snap())
      assert(/people/i.test(text), 'the tiles still state the folder')
      await A.shot('s122-A-no-match', runDir)
    })

    await r.ok('clearing restores the folder', async () => {
      await A.click({ role: 'button', name: 'Clear filter' })
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /readme\.txt/i.test(text) && !/no files match/i.test(text)
      }, 20000, 'every row is back')
      await A.shot('s122-A-cleared', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
