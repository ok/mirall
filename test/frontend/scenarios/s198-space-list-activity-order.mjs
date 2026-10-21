import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { allText } from '../tree.mjs'

// The spaces grid lists the most recently active space first, and each card says when it was last
// active. Renaming the older space is activity in it, so it moves above the newer one.
export default async function s198({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  // Whether card `first` comes before card `second` in the grid, by the cards' accessible names.
  const above = async (first, second) => {
    const text = allText(await A.snap())
    const a = text.indexOf(`Open ${first}`)
    const b = text.indexOf(`Open ${second}`)
    return a !== -1 && b !== -1 && a < b
  }

  try {
    await r.ok('two spaces: the newer one is listed first and reads as active now', async () => {
      await A.launch()
      await A.createSpaceOnly('Older')
      await A.back()
      await A.createSpaceOnly('Newer')
      await A.back()
      await waitFor(() => above('Newer', 'Older'), 20000, 'Newer above Older')
      await A.waitText('Active now', 8000)
      await A.shot('s198-before', runDir)
    })

    await r.ok('activity in the older space moves it to the top', async () => {
      await A.click({ name: 'Open Older' })
      await A.openEditSpace()
      await A.type({ role: 'textfield' }, 'Older Renamed')
      await A.click({ role: 'button', name: 'Save Changes' })
      await A.waitText('Older Renamed', 8000)
      await A.back()
      await waitFor(() => above('Older Renamed', 'Newer'), 20000, 'Older Renamed above Newer')
      await A.shot('s198-after', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
