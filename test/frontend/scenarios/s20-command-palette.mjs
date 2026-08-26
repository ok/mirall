import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Command palette (Cmd+K): typing a query and pressing Enter executes the matched
// command; the Cmd+N shortcut opens the same Create Space flow directly. Also covers
// the screens and system commands the palette must be able to reach.
export default async function s20 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  const palette = async (query) => {
    await A.press('cmd+k')
    await new Promise((res) => setTimeout(res, 600))
    await A.type({ role: 'combobox' }, query)
  }

  try {
    await r.ok('launch', async () => { await A.launch() })
    await r.ok('Cmd+K → search → Enter opens Create Space', async () => {
      await palette('new space')
      await A.press('return')
      await A.waitText('Create a New Space', 8000)
      await A.press('escape')
      await A.shot('s20-palette', runDir)
    })
    await r.ok('Cmd+N opens Create Space directly', async () => {
      await A.press('cmd+n')
      await A.waitText('Create a New Space', 8000)
      await A.press('escape')
    })
    await r.ok('the palette reaches the Activity Log', async () => {
      await palette('activity log')
      await A.press('return')
      await A.waitText('A record of what happened', 8000)
      await A.shot('s20-palette-activity', runDir)
      await A.back()
    })
    await r.ok('the palette reaches a settings sub-page', async () => {
      await palette('storage settings')
      await A.press('return')
      await A.waitText('Storage', 8000)
      await A.back()
    })
    // Regression: these were registered in the 'system' group, which the palette
    // filtered out wholesale, so neither could ever be found by typing.
    await r.ok('the palette offers the system commands', async () => {
      await palette('feedback')
      if (!(await A.hasText('Send feedback'))) throw new Error('Send feedback missing from the palette')
      await A.press('escape')
      await palette("what's new")
      if (!(await A.hasText("What's new"))) throw new Error("What's new missing from the palette")
      await A.press('escape')
      await A.shot('s20-palette-system', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
