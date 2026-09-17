import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Network status: the relay row is always present in the summary, the dial-side counter is in the
// advanced block, and the relayed-connections section (present only while a relay carries a
// connection) exposes its reveal and copy controls by name.
export default async function s144({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Network status', async () => {
      await A.launch()
      await A.openNetworkStatus()
    })
    await r.ok('the summary carries a relay row with one of its three values', async () => {
      if (!(await A.hasText('Relay'))) throw new Error('relay row missing from the connection summary')
      const values = ['Not in use', 'Off', 'Used for']
      let seen = false
      for (const value of values) if (await A.hasText(value)) seen = true
      if (!seen) throw new Error(`relay row shows none of: ${values.join(' / ')}`)
    })
    await r.ok('advanced details show the relays this device chose', async () => {
      await A.click({ role: 'button', name: 'Advanced details' })
      await A.waitText('Own relay chosen since start', 8000)
      await A.back()
      await A.waitText('Connection summary', 8000)
    })
    await r.ok('the relayed section, when present, exposes its controls by name', async () => {
      if (!(await A.hasText('Relayed connections'))) return
      if (!(await A.has({ role: 'button', name: 'Reveal' }))) throw new Error('reveal button not reachable by name')
      if (!(await A.has({ role: 'button', name: 'Copy' }))) throw new Error('copy button not reachable by name')
    })
    await A.shot('s144-relay-transparency', runDir)
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
