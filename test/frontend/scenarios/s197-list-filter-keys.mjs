import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// ⌘F focuses the filter of whichever list is on screen, the space's or the folder's, and is not
// offered where there is no list to filter.
//
// Every palette assertion is a string strictly LONGER than the query typed to reach it: the input's
// own value is part of the window text (see s124).
export default async function s197({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'readme.txt'), 'so the folder has a file to filter')

  const palette = async (query) => {
    await A.press('cmd+k')
    await new Promise((res) => setTimeout(res, 600))
    await A.type({ role: 'combobox' }, query)
    await new Promise((res) => setTimeout(res, 400))
  }

  // The keystroke after ⌘F lands in the field only if the chord moved focus there.
  const findTypesInto = async (name) => {
    await A.press('cmd+f')
    await A.press('z')
    const deadline = Date.now() + 5000
    let value = null
    while (Date.now() < deadline) {
      value = await A.nodeValue({ name })
      if (value === 'z') return
      await new Promise((res) => setTimeout(res, 200))
    }
    throw new Error(`${name} did not take the keystroke (value ${JSON.stringify(value)})`)
  }

  try {
    await r.ok('the home screen has no list to filter, so no find entry', async () => {
      await A.launch()
      await palette('search or')
      assert(!(await A.hasText('Search or filter')), 'no find entry without a list')
      await A.press('escape')
    })

    await r.ok('Cmd+F focuses the space filter', async () => {
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Archive', 60000)
      await findTypesInto('Filter files in this space')
      await A.shot('s197-space-filter', runDir)
      await A.press('escape')
    })

    await r.ok('Cmd+F focuses the folder filter', async () => {
      await A.openFolder('Archive')
      await A.waitText('readme.txt', 20000)
      await findTypesInto('Filter files in this folder')
      await A.shot('s197-folder-filter', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
