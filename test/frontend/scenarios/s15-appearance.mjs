import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Appearance settings: a zoom level applies (aria-pressed flips) and switching
// the interface language re-renders visible strings (English → Deutsch → back).
// Theme switching is already covered by s8.
export default async function s15 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Appearance settings', async () => {
      await A.launch()
      await A.gotoSettings('Appearance')
      await A.waitText('Appearance', 8000)
    })
    await r.ok('selecting a zoom level marks it pressed', async () => {
      await A.click({ name: 'Spacious' })
      await waitFor(async () => (await A.nodeValue({ name: 'Spacious' })) === '1', 8000, 'Spacious pressed')
      await A.shot('s15-zoom', runDir)
    })
    await r.ok('switching language re-renders the UI, then switches back', async () => {
      await A.click({ name: 'Deutsch' })
      await A.waitText('Darstellung', 8000)
      await A.click({ name: 'English' })
      await A.waitText('Appearance', 8000)
      await A.shot('s15-language', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
