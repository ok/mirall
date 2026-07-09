import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'

// On-demand cache size control in Storage Settings. Verifies the slider is reachable
// by its accessible name and role (the a11y bar: agent-desktop must target it by
// name/role), exposes a value, and responds to keyboard stepping — i.e. it is a
// real, operable, labelled slider, not a mouse-only widget.
export default async function s47 ({ runDir, bootstrap }) {
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  const slider = { role: 'slider', name: 'On-demand cache size' }

  try {
    await r.ok('Storage Settings shows an accessible On-demand cache slider', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openManageStorage()
      await A.waitText('On-demand cache', 20000)
      assert(await A.has(slider), 'cache slider not reachable by role=slider + accessible name')
      await A.shot('s47-cache-slider', runDir)
    })

    await r.ok('the slider exposes a value and steps with the keyboard', async () => {
      const before = await A.nodeValue(slider)
      assert(before != null && before !== '', 'slider exposes no value')
      await A.click(slider)
      await A.press('ArrowRight')
      const after = await A.nodeValue(slider)
      assert(after !== before, `slider value did not change on ArrowRight (${before} → ${after})`)
      await A.shot('s47-cache-slider-stepped', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
