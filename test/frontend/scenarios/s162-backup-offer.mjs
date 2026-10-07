import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// The backup is offered on Spaces once there is a space to protect, and "Not now" puts it away with a
// pointer to where it lives.
export default async function s162({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('no offer before there is a space', async () => {
      await A.launch()
      await A.waitText('No spaces yet', 30000)
      if (await A.hasText('Protect Your Spaces')) throw new Error('offered with nothing to protect')
    })
    await r.ok('the first space brings the offer', async () => {
      await A.createSpaceOnly('Aurora')
      await A.click({ name: 'Home' })
      await A.waitText('Protect Your Spaces', 15000)
      if (!(await A.has({ role: 'button', name: 'Set up backup' }))) throw new Error('no Set up backup button')
      await A.shot('s162-offer', runDir)
    })
    await r.ok('"Not now" hides it and says where it lives', async () => {
      await A.click({ role: 'button', name: 'Not now' })
      await A.waitText('You can set up a backup anytime in Settings → Backup.', 8000)
      await waitFor(async () => !(await A.has({ role: 'button', name: 'Set up backup' })), 8000, 'offer gone')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
