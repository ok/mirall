import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { makeReport } from '../assert.mjs'

// About settings: the version is copyable and the What's New modal opens.
export default async function s18 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 1 })

  try {
    await r.ok('launch + open About', async () => {
      await A.launch()
      await A.gotoSettings('About')
      await A.waitText('Version', 8000)
    })
    await r.ok('the version string is copyable', async () => {
      const v = await A.copyFrom({ name: 'Copy', last: true })
      if (!/\d+\.\d+/.test(v)) throw new Error(`unexpected version: ${v}`)
      await A.shot('s18-about', runDir)
    })
    await r.ok('the old "peer-to-peer file sharing" tagline is gone', async () => {
      if (await A.hasText('Peer-to-peer file sharing')) throw new Error('tagline should have been removed')
    })
    await r.ok("the What's New modal opens", async () => {
      await A.click({ name: "What's new" })
      await A.waitText('Got it', 8000)
      await A.click({ role: 'button', name: 'Got it' })
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
