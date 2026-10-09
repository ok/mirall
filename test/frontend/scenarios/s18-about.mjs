import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// About Mirall: reached from the Profile page's App group, it shows the copyable version and the
// update verdict, opens What's New, and links to Mirall's license. The harness runs with
// --no-updates, so the verdict is the "off" one and offers no check.
export default async function s18({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch', async () => {
      await A.launch()
    })
    await r.ok('Settings offers no About tile', async () => {
      await A.openSettings()
      await A.waitText('Activity Log', 8000)
      if (await A.has({ role: 'button', name: 'About' })) throw new Error('About tile present in Settings')
      await A.back()
    })
    await r.ok('the Profile page leads to About Mirall', async () => {
      await A.openAccount()
      await A.waitText('App', 8000)
      if (await A.has({ name: "What's New" })) throw new Error("What's New should live on About, not Profile")
      await A.click({ role: 'button', name: 'About Mirall' })
      await A.waitText('Version, updates, and who makes Mirall', 8000)
      await A.shot('s18-about', runDir)
    })
    await r.ok('the version string is copyable', async () => {
      const v = await A.copyFrom({ name: 'Copy' })
      if (!/^Mirall v\d+\.\d+/.test(v)) throw new Error(`unexpected version: ${v}`)
    })
    await r.ok('a build with updates off says so and offers no check', async () => {
      await A.waitText('Automatic updates are off', 8000)
      if (await A.has({ role: 'button', name: 'Check now' })) throw new Error('Check now offered with updates off')
    })
    await r.ok("the What's New modal opens", async () => {
      await A.click({ role: 'button', name: "What's New" })
      await A.waitText('Got it', 8000)
      await A.click({ role: 'button', name: 'Got it' })
    })
    await r.ok("the legal section links to Mirall's license", async () => {
      if (!(await A.has({ name: "Mirall's License" }))) throw new Error("no Mirall's License row")
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
