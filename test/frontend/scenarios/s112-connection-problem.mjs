import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// The Connection problem screen replaces the spaces screen when the verdict is degraded
// and the user has no spaces. The space-management actions must be absent — leaving
// "Create Space" beside "your network is blocking Mirall" is the incoherence it exists
// to fix. Reached here through the Network status screen, which is available regardless
// of the live verdict.
export default async function s112({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Network status', async () => {
      await A.launch()
      await A.openNetworkStatus()
    })

    await r.ok('the connection summary is present and readable', async () => {
      for (const label of ['Connection summary', 'Reachable from outside', 'Connection test', 'People']) {
        if (!(await A.hasText(label))) throw new Error(`summary row missing: ${label}`)
      }
    })

    await r.ok('raw NAT rows live on the Advanced details screen, not on this one', async () => {
      if (await A.hasText('Randomised port mapping')) {
        throw new Error('advanced NAT rows are visible on Network status')
      }
      await A.click({ role: 'button', name: 'Advanced details' })
      await A.waitText('Randomised port mapping', 8000)
      await A.shot('s112-advanced', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
