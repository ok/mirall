import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert } from '../assert.mjs'
import { connectInSpace } from '../helpers.mjs'
import { workDir } from '../paths.mjs'

// The space screen and the folder screen now take their header from one component. Nothing below is
// visible to a unit test: the header is where the back control, the title, the eyebrow line and the
// actions cluster meet, and the extraction moved the <h1> into a flex row beside a badge slot —
// exactly the change that splits an AX node while typecheck, lint and every ratchet stay green.
//
// Both screens are asserted through the AX tree, in both directions of a navigation, and on both
// sides of the share so the owner and the peer eyebrow are each exercised.
export default async function s136({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('hdr-'), 'Quarterlies')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'so the folder exists at share time')

  try {
    await r.ok('A and B share a space; A owns "Quarterlies"', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.focus()
      await A.addOwnedFolder(ownDir)
      await A.waitText('Quarterlies', 60000)
    })

    await r.ok('the space header carries a back control, the space name and its actions', async () => {
      assert(await A.has({ name: 'Back' }), 'the back control is reachable by name')
      assert(await A.hasText('Aurora'), 'the space name is on screen')
      assert(await A.has({ name: 'Invite' }), 'the primary action is reachable by name')
      assert(await A.has({ name: 'More' }), 'the overflow menu is reachable by name')
      await A.shot('s136-space-header', runDir)
    })

    await r.ok("the owner's folder header says who shares it, and offers the folder acts", async () => {
      await A.openFolder('Quarterlies')
      // Wait on the space clause, not on "Shared by you": the folder CARD says the latter too, so a
      // wait on it returns while the space screen is still up and the assertions below race the
      // navigation.
      await A.waitText('in Aurora', 20000)
      assert(await A.hasText('Shared by you'), 'the eyebrow says who shares it')
      assert(await A.has({ name: 'Back' }), 'the back control survives the second screen')
      assert(await A.has({ name: 'Open Folder' }), 'the primary action is reachable by name')
      assert(await A.has({ name: 'More' }), 'and so is the overflow menu')
      await A.shot('s136-folder-header-owner', runDir)
    })

    await r.ok('going back restores the space header', async () => {
      await A.back()
      await A.waitText('Aurora', 20000)
      assert(await A.has({ name: 'Invite' }), 'the space actions are back')
      // The folder screen's eyebrow must not survive the navigation: a header that kept it would be
      // a header rendered for the wrong screen.
      //
      // The discriminator is the SPACE clause, not "Shared by you". hasText matches the whole
      // window, and the folder CARD's meta line (shareSizeLine) says "Shared by you" too for every
      // folder you own — so that string is on the space screen by design and proves nothing here.
      // `space.in` has exactly one renderer, the folder eyebrow.
      assert(!(await A.hasText('in Aurora')), 'the folder eyebrow is gone with the folder screen')
    })

    await r.ok("the peer's folder header names the owner instead", async () => {
      await B.focus()
      await B.waitText('Quarterlies', 60000)
      await B.openFolder('Quarterlies')
      await B.waitText('in Aurora', 20000)
      assert(await B.hasText('Owned by Alice'), 'the eyebrow names the owner instead of you')
      assert(await B.has({ name: 'Back' }), 'the back control is there for the peer too')
      await B.shot('s136-folder-header-peer', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
