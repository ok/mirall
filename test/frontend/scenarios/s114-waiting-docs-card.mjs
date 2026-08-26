import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'

// A joiner waiting for approval gets the "Why am I waiting?" card explaining that the
// invite carries the address of the space and not the key to it, with deep links into the
// documentation. The withdraw path must keep working alongside it.
// Local-only (real Electron + AX).
export default async function s114 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    await r.ok('a pending joiner sees the waiting docs card', async () => {
      await A.launch(); await B.launch()
      const code = await createSpaceWithInvite(A, { name: 'Approval' })
      await joinPending(B, code)

      await B.focus()
      await B.waitText('Why am I waiting?', 15000)
      assert(await B.hasText('never the key to it'), 'the card states the invite/key distinction')
      assert(await B.has({ role: 'link', contains: 'How membership and approval work' }), 'explanation link present')
      assert(await B.has({ role: 'link', contains: 'Fix a join that gets stuck' }), 'stuck-join link present')
      await B.shot('s114-waiting-docs', runDir)
    })

    await r.ok('the withdraw action still works alongside the card', async () => {
      await B.click({ role: 'button', name: 'Cancel request' })
      await B.waitText('No spaces yet', 15000)
    })
  } catch {}

  return { pass: r.summary(), instances: [A, B] }
}
