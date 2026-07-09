import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'

export default async function s8({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  try {
    await r.ok('launch + onboard', async () => {
      await A.launch()
    })
    // aria-pressed/aria-checked toggles surface as role "checkbox"/"switch"
    // (not "button") and expose pressed state in `value` ("0"/"1") — so match
    // by name only and assert via the value.
    await r.ok('Appearance: switching to Dark sets it pressed', async () => {
      await A.click({ name: 'Settings' })
      await A.waitText('Appearance', 10000)
      await A.click({ name: 'Appearance' })
      await A.waitText('Theme Mode', 10000)
      await A.click({ name: 'Dark' })
      await new Promise((res) => setTimeout(res, 400))
      assert((await A.nodeValue({ name: 'Dark' })) === '1', 'Dark theme not pressed after click')
      await A.shot('s8-dark', runDir)
    })
    // REGRESSION: the toggle read its value from a renderer cache that the
    // write path never updated, so leaving and re-opening Appearance snapped
    // the selection back to the boot-time default ("System"). Verify the chosen
    // theme survives an unmount/remount of the settings screen.
    await r.ok('Appearance: chosen theme persists across screen remount', async () => {
      await A.click({ name: 'Back' })
      await A.waitText('Notifications', 10000)
      await A.click({ name: 'Appearance' })
      await A.waitText('Theme Mode', 10000)
      await new Promise((res) => setTimeout(res, 400))
      assert((await A.nodeValue({ name: 'Dark' })) === '1', 'Dark theme not still pressed after remount')
      assert((await A.nodeValue({ name: 'System' })) !== '1', 'theme reset to System after remount')
    })
    await r.ok('Notifications: a switch toggles its state', async () => {
      await A.click({ name: 'Back' })
      await A.waitText('Notifications', 10000)
      await A.click({ name: 'Notifications' })
      await A.waitText('Show desktop notifications', 10000)
      const sel = { name: 'Show desktop notifications' }
      const before = await A.nodeValue(sel)
      await A.click(sel)
      await new Promise((res) => setTimeout(res, 400))
      const after = await A.nodeValue(sel)
      assert(before !== after, `switch did not toggle (before=${before}, after=${after})`)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
