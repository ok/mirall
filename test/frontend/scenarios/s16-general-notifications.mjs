import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// Settings toggles (role=switch, aria-checked) round-trip: "Launch at login" in
// General and "Play sound" in Notifications flip when clicked.
export default async function s16 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch', async () => { await A.launch() })
    await r.ok('General: the launch-at-login switch flips', async () => {
      await A.gotoSettings('General')
      const before = await A.nodeValue({ name: 'Launch at login' })
      await A.click({ name: 'Launch at login' })
      await waitFor(async () => (await A.nodeValue({ name: 'Launch at login' })) !== before, 8000, 'login switch flips')
      await A.shot('s16-general', runDir)
    })
    await r.ok('Notifications: the play-sound switch flips', async () => {
      await A.gotoSettings('Notifications')
      const before = await A.nodeValue({ name: 'Play sound' })
      await A.click({ name: 'Play sound' })
      await waitFor(async () => (await A.nodeValue({ name: 'Play sound' })) !== before, 8000, 'sound switch flips')
      await A.shot('s16-notifications', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
