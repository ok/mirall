import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Network status ends in a Troubleshooting group whose two rows are destinations, not disclosures:
// the raw values and the support bundle each live on their own screen, and both back out to
// Network status rather than to the screen it was opened from.
export default async function s146({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Network status', async () => {
      await A.launch()
      await A.openNetworkStatus()
    })

    await r.ok('both troubleshooting rows are reachable by name, and nothing is expanded', async () => {
      await A.waitText('Troubleshooting', 8000)
      for (const name of ['Diagnostics', 'Advanced details']) {
        if (!(await A.has({ role: 'button', name }))) throw new Error(`troubleshooting row missing: ${name}`)
      }
      if (await A.hasText('Routing-table size')) throw new Error('advanced rows are on Network status')
      if (await A.hasText('Remove identifying details')) throw new Error('diagnostics toggles are on Network status')
      await A.shot('s146-troubleshooting', runDir)
    })

    await r.ok('Advanced details opens as a screen and backs out to Network status', async () => {
      await A.click({ role: 'button', name: 'Advanced details' })
      await A.waitText('The raw values behind your connection', 8000)
      for (const label of ['Connection', 'Address', 'NAT', 'Relaying', 'DHT', 'Connection test']) {
        if (!(await A.hasText(label))) throw new Error(`advanced section missing: ${label}`)
      }
      // The screen is read-only: taking these values elsewhere is the diagnostics export's job.
      if (await A.has({ role: 'button', name: 'Copy all' })) throw new Error('advanced details still offers a bulk copy')
      await A.shot('s146-advanced', runDir)
      await A.back()
      await A.waitText('Troubleshooting', 8000)
    })

    await r.ok('the public key stays masked until it is revealed', async () => {
      await A.click({ role: 'button', name: 'Advanced details' })
      await A.waitText('Your public key', 8000)
      if (!(await A.has({ role: 'button', name: 'Reveal' }))) throw new Error('reveal button not reachable by name')
      await A.back()
    })

    await r.ok('Diagnostics opens as a screen and backs out to Network status', async () => {
      await A.click({ role: 'button', name: 'Diagnostics' })
      await A.waitText('If we ask you for details', 8000)
      if (!(await A.has({ role: 'switch', name: 'Remove identifying details' }))) {
        throw new Error('redaction toggle not reachable by name')
      }
      await A.back()
      await A.waitText('Connection summary', 8000)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
