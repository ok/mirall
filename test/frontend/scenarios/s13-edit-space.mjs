import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// EditSpaceModal rename + icon change, then favoriting from the space's More menu
// and finding the space under the Favorites tab.
export default async function s13 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + create space', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
    })
    await r.ok('rename the space and change its icon', async () => {
      await A.openEditSpace()
      await A.type({ role: 'textfield' }, 'Aurora Renamed')
      await A.click({ name: 'Music' })
      await A.click({ role: 'button', name: 'Save Changes' })
      await A.waitText('Aurora Renamed', 8000)
      await A.shot('s13-renamed', runDir)
    })
    await r.ok('favorite the space and find it under the Favorites tab', async () => {
      await A.click({ name: 'More' })
      await new Promise((res) => setTimeout(res, 400))
      await A.click({ name: 'Add to Favorites' })
      await A.back()
      await A.click({ name: 'Favorites' })
      await A.waitText('Aurora Renamed', 8000)
      await A.shot('s13-favorited', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
