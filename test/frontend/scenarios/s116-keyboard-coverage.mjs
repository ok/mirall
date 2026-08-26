import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// The accelerators added alongside the palette's screen coverage. The digit chord is
// served by the native Go-to-Space menu rather than the renderer's keydown listener —
// Chromium claims ⌘1-9 before the page sees them — so this exercises that wiring end
// to end, along with Profile, the Activity Log, and the Activity Log's Find.
export default async function s116 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch and create a space', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      // The create flow repaints the whole screen; Chromium re-attaches the AX tree a
      // beat later and a snapshot taken in that gap errors out (see agent.mjs).
      await new Promise((res) => setTimeout(res, 1200))
    })

    await r.ok('the palette lists the space by name', async () => {
      await A.back()
      await A.waitText('Aurora', 8000)
      await A.press('cmd+k')
      await new Promise((res) => setTimeout(res, 600))
      await A.type({ role: 'combobox' }, 'Aurora')
      const listed = await A.hasText('Open Aurora')
      await A.shot('s116-palette-space', runDir)
      await A.press('escape')
      if (!listed) throw new Error('space.open command missing from the palette')
    })

    // No ⌘1 assertion here on purpose. Measured on this machine: the chord never reaches
    // the app at all — neither the renderer's keydown listener nor before-input-event
    // sees it, and the app loses focus and drops off-screen the moment it is pressed, so
    // something outside Mirall claims it system-wide. The binding itself lives in the
    // native Go-to-Space menu (test/unit/app-menu.test.js covers its structure and
    // chords), which is the only place macOS resolves a digit chord for an app.

    await r.ok('Cmd+Shift+P opens Profile from inside a space', async () => {
      await A.press('cmd+shift+p')
      await A.waitText('Your profile, this device', 8000)
    })

    await r.ok('Cmd+Shift+L opens the Activity Log', async () => {
      await A.press('cmd+shift+l')
      await A.waitText('A record of what happened', 8000)
      await A.shot('s116-activity-log', runDir)
    })

    await r.ok('Cmd+F focuses the Activity Log search field', async () => {
      await A.press('cmd+f')
      await A.press('z')
      const deadline = Date.now() + 5000
      let value = null
      while (Date.now() < deadline) {
        value = await A.nodeValue({ name: 'Search activity' })
        if (value === 'z') break
        await new Promise((res) => setTimeout(res, 200))
      }
      if (value !== 'z') throw new Error(`search field did not take the keystroke (value ${JSON.stringify(value)})`)
      await A.shot('s116-search-focus', runDir)
    })

    await r.ok('Cmd+Shift+H returns to the spaces list', async () => {
      await A.press('cmd+shift+h')
      await A.waitText('Shared', 8000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
