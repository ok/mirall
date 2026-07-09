import { mkdirSync } from 'node:fs'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'

// The spaces-grid SpaceCard facepile reads the full roster (avatars) from space:members via
// the module-cached useSpaceMembers hook — spaces:list rosters are slim. On the grid a card
// shows only its name, member count, date, and the facepile avatars, so a member's name there
// comes ONLY from a facepile avatar's accessible label — a targeted check that the async roster
// path actually populates the card.
export default async function s81 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  try {
    await r.ok('A and B share "Aurora"', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.focus()
      await A.waitText('Members', 60000)
      await A.waitText('Bob', 60000)
    })

    await r.ok('back on the spaces grid, A’s card facepile shows Bob', async () => {
      await A.back()
      await A.waitText('Open Aurora', 30000)
      // On the grid, "Bob" can only be a facepile avatar's accessible label (the card body is
      // name + count + date). It arrives via the async space:members roster, not the slim list.
      await waitFor(async () => A.hasText('Bob'), 30000, 'card facepile shows Bob')
      await A.shot('s81-grid-facepile', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
