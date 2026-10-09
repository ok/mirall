import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// A member who mirrors a folder has every file in it, so the owner's rows say so on each file — not
// only on files the member happened to download one by one.
export default async function s166({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Designs')
  const mirrorDir = workDir('mirror-')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'brief.txt'), 'the brief')
  writeFileSync(path.join(ownDir, 'notes.txt'), 'the notes')

  const HAVE = { role: 'button', name: 'Bob has it' }
  const haveCount = async () => {
    try { return flatten(await A.snap()).filter((n) => n.role === HAVE.role && n.name === HAVE.name).length } catch { return 0 }
  }

  try {
    await r.ok('A shares "Designs"; before anyone has a file, its rows say nothing about recipients', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await A.waitText('Designs', 60000)
      await A.openFolder('Designs')
      await A.waitText('notes', 30000)
      assert((await haveCount()) === 0, 'no recipients cluster before Bob has anything')
    })

    await r.ok('B mirrors the folder; every one of A\'s rows reads "Bob has it"', async () => {
      await B.waitText('Designs', 60000)
      await B.mirrorShare(mirrorDir)
      await waitFor(async () => (await haveCount()) === 2, 120000, 'both rows name Bob as having the file')
      await A.shot('s166-A-rows', runDir)
    })

    await r.ok('the list on a row names Bob under the files he has', async () => {
      await A.click(HAVE)
      await waitFor(() => A.has({ name: 'People and this file' }), 8000, 'recipients region')
      await A.waitText('Bob has it, received', 8000)
      await A.shot('s166-A-expanded', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
