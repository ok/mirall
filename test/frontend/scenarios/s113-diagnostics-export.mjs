import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// The diagnostics card: both toggles reachable by accessible name, and the preview modal
// shows the real bundle before anything is written.
export default async function s113 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open Network status', async () => {
      await A.launch()
      await A.openNetworkStatus()
    })

    await r.ok('both diagnostics toggles are reachable by name', async () => {
      for (const name of ['Remove identifying details', 'Include detailed logs']) {
        if (!(await A.has({ role: 'switch', name }))) throw new Error(`toggle missing: ${name}`)
      }
    })

    await r.ok('preview opens, shows the bundle, and closes', async () => {
      await A.click({ role: 'button', contains: "Preview what's included" })
      await A.waitText("What's in the file", 15000)
      if (!(await A.hasText('"schema"'))) throw new Error('preview does not show the bundle JSON')
      await A.shot('s113-preview', runDir)
      await A.click({ role: 'button', name: 'Close' })
    })

    await r.ok('the redacted preview carries no public key', async () => {
      await A.click({ role: 'button', contains: "Preview what's included" })
      await A.waitText("What's in the file", 15000)
      if (await A.hasText('"publicKey"')) {
        throw new Error('redacted preview exposed publicKey')
      }
      await A.click({ role: 'button', name: 'Close' })
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
