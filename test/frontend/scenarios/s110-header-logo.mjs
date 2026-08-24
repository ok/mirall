import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { flatten } from '../tree.mjs'

// The header wordmark is an inline SVG, not text. Swapping text for graphics is
// exactly where a name silently drops out of the AX tree, so this pins both
// halves of the a11y contract: the top bar's logo is decorative inside an
// already-named button (one node, still named, still navigates home), while the
// onboarding header carries the name itself because nothing around it does.
export default async function s110 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('onboarding header exposes the wordmark as a named image', async () => {
      await A.launch({ onboard: false })
      await A.waitText('Welcome to Mirall', 45000)
      assert(await A.has({ role: 'image', name: 'Mirall' }), 'onboarding logo is not an image named "Mirall"')
      await A.shot('s110-onboarding-logo', runDir)
    })

    await r.ok('top bar logo stays one node, named "Home"', async () => {
      await A.onboard()
      assert(await A.has({ role: 'button', name: 'Home' }), 'top bar home button lost its accessible name')
      // The decorative half: the SVG must not surface an announceable node of
      // its own next to the button that already names it. A logo that reads as
      // "Home, Mirall image" is the regression this catches. Scoped to images —
      // the window, its group and the webarea are all named "Mirall" already.
      const images = flatten(await A.snap()).filter((n) => n.role === 'image')
      assert(images.length === 0, `top bar logo announces itself as ${images.length} image(s): ${images.map((n) => n.label).join(', ')}`)
      await A.shot('s110-topbar-logo', runDir)
    })

    await r.ok('clicking the logo returns home from a subscreen', async () => {
      await A.openSettings()
      await A.click({ role: 'button', name: 'Home' })
      await A.waitText('Create Space', 15000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
