import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'

// An install without an organization shows nothing of the feature: no lock, no note, no
// Organization row. (Not "license": About already shows "Mirall's License".)
export default async function s185({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  try {
    await r.ok('Network, Activity Log and About carry no trace of an organization', async () => {
      await A.launch()
      await A.gotoSettings('Network')
      await A.waitText('A relay helps two devices connect', 8000)
      assert(!(await A.hasText('Set by')), 'no lock note on Network')
      await A.gotoSettings('Activity Log')
      await A.waitText('Record activity', 8000)
      assert(!(await A.hasText('Set by')), 'no lock note on the Activity Log')
      assert(!(await A.isDisabled({ role: 'switch', name: 'Record activity' })), 'the recording switch is usable')
      await A.openAccount()
      await A.click({ role: 'button', name: 'About Mirall' })
      await A.waitText('Version, updates', 8000)
      assert(!(await A.has({ role: 'button', name: 'Organization' })), 'no Organization row on About')
      assert(!(await A.hasText('Leave organization')), 'nothing to leave')
      await A.shot('s185-about-unmanaged', runDir)
    })

    await r.ok('the palette offers no organization entry', async () => {
      await A.press('cmd+k')
      await new Promise((res) => setTimeout(res, 600))
      await A.type({ role: 'combobox' }, 'organization')
      await new Promise((res) => setTimeout(res, 400))
      assert(!(await A.hasText('Open organization')), 'no organization entry')
      await A.press('escape')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
