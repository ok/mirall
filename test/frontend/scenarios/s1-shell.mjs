import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

export default async function s1({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })
  try {
    await r.ok('launch + onboard -> Shared Spaces', async () => {
      await A.launch()
      await A.waitText('Create Space')
    })
    await r.ok('screenshot spaces', async () => {
      await A.shot('s1-spaces', runDir)
    })
    await r.ok('Send Feedback opens modal', async () => {
      await A.click({ role: 'button', name: 'Send Feedback' })
      await A.waitText("Let us know")
      await A.press('escape')
    })
    await r.ok('Cmd+K opens command palette', async () => {
      await A.press('cmd+k')
      await A.waitText('Type a command')
      await A.press('escape')
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
