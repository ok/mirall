import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'

// Free up, end to end: with the threshold lowered to zero the row is offered on a fresh profile, and
// a click runs every step through to the result, which the status line announces.
export default async function s156({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  process.env.MIRALL_FREE_UP_MIN_BYTES = '0'
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch and open Storage Settings', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.openManageStorage()
    })
    await r.ok('the Free up row is offered', async () => {
      await A.waitText('can be freed', 20000)
      assert(await A.has({ role: 'button', contains: 'Free up' }), 'the button is reachable by name')
    })
    await r.ok('Free up runs to its result', async () => {
      await A.click({ role: 'button', contains: 'Free up' })
      await A.waitText('Freed', 60000)
      assert(await A.hasText('Mirall now uses'), 'the result names the new total')
      assert(!(await A.has({ role: 'button', contains: 'Free up' })), 'the button is gone once it has run')
      await A.shot('s156-freed', runDir)
    })
  } catch {} finally {
    delete process.env.MIRALL_FREE_UP_MIN_BYTES
  }
  return { pass: r.summary(), instances: [A] }
}
