import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// Network status screen (reached via Account): the reconnect control — shown only when the
// verdict is not online — is reachable by its accessible name when present.
export default async function s17 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Network status', async () => {
      await A.launch()
      await A.openNetworkStatus()
    })
    await r.ok('reconnect, when shown, is reachable by its accessible name', async () => {
      const reconnectSel = { role: 'button', name: 'Reconnect' }
      if (await A.has(reconnectSel)) {
        await A.click(reconnectSel)
        await A.shot('s17-reconnect', runDir)
      } else if (!(await A.hasText('healthy'))) {
        throw new Error('reconnect button absent but the verdict is not the healthy/online state')
      }
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
