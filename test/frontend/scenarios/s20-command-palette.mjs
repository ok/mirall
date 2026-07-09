import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Command palette (Cmd+K): typing a query and pressing Enter executes the matched
// command; the Cmd+N shortcut opens the same Create Space flow directly.
export default async function s20 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch', async () => { await A.launch() })
    await r.ok('Cmd+K → search → Enter opens Create Space', async () => {
      await A.press('cmd+k')
      await new Promise((res) => setTimeout(res, 600))
      await A.type({ role: 'combobox' }, 'new space')
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
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
