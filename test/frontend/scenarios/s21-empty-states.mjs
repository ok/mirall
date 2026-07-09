import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Empty states: a fresh profile shows the no-spaces and no-favorites copy, and a
// freshly created space shows the empty-share copy.
export default async function s21 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('a fresh profile has no spaces', async () => {
      await A.launch()
      await A.waitText('No spaces yet', 8000)
      await A.shot('s21-no-spaces', runDir)
    })
    await r.ok('the Favorites tab is empty', async () => {
      await A.click({ name: 'Favorites' })
      await A.waitText('No favorites yet', 8000)
      await A.click({ name: 'All Spaces' })
    })
    await r.ok('a new space shows the empty-share copy', async () => {
      await A.createSpaceOnly('Aurora')
      await A.waitText('Nothing shared yet', 8000)
      await A.shot('s21-empty-space', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
