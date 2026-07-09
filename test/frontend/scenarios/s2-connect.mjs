import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport } from '../assert.mjs'

export default async function s2({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })
  try {
    await r.ok('launch A + B (sequential, window-diff)', async () => {
      await A.launch()
      await B.launch()
    })
    await r.ok('A creates space, B joins via invite code', async () => {
      await connectInSpace(A, B, { name: 'Aurora' })
    })
    await r.ok('membership converges: A sees Bob', async () => {
      await A.waitText('Bob', 60000)
      await A.shot('s2-A-members', runDir)
    })
    await r.ok('membership converges: B sees Alice', async () => {
      await B.waitText('Alice', 60000)
      await B.shot('s2-B-members', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
