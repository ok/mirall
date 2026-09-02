import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText, flatten, findNode } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// Renaming a folder is a LABEL change: `share.name` stays put because it is the first segment of
// the drive path every member's download claims are keyed by, and `displayName` carries what people
// read. From the screen that is invisible — which is the point — so what this proves is the visible
// half: the modal opens from More, saves, the header follows, and reopening shows the saved name
// rather than a stale draft.
const NAME_FIELD = { name: 'Folder name' }

export default async function s123 ({ runDir }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', slot: 0, total: 1 })

  const ownDir = path.join(workDir('own-'), 'Archive')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'readme.txt'), 'so the folder exists at share time')

  try {
    await r.ok('A shares "Archive" and opens it', async () => {
      await A.launch()
      await A.createSpaceOnly('Aurora')
      await A.addOwnedFolder(ownDir)
      await A.waitText('Archive', 60000)
      await A.openFolder('Archive')
      await A.waitText('readme.txt', 60000)
    })

    await r.ok('More carries Edit Folder, and it opens a dialog', async () => {
      // Addressable by role+name IS the accessibility proof: a control the AX tree cannot name is
      // an a11y gap in the control, not a gap in the test.
      // Unscoped by role, like every other scenario that opens an ActionMenu: react-aria puts
      // aria-haspopup on the trigger, so macOS exposes it as a pop-up button (agent-desktop
      // reports role `combobox`, not `button`). VoiceOver says "More, pop-up button" — the right
      // native idiom for a menu, so the name is the part worth asserting.
      await A.click({ name: 'More' })
      await A.click({ contains: 'Edit Folder' })
      await A.waitText('Edit Folder', 15000)
      const text = allText(await A.snap())
      assert(/folder name/i.test(text), 'the name field is labelled')
      assert(/source folder/i.test(text), 'and the folder’s location is shown')
      // The location renders in the same field Add Folder and Mirror to Disk use; FilePath carries
      // the whole path in an sr-only node, so the AX tree sees it in full even when the visible
      // form is middle-truncated.
      assert(text.includes(ownDir), 'the source path itself is present, not just its label')
      await A.shot('s123-A-modal', runDir)
    })

    await r.ok('a healthy folder shows its location but does not offer to re-point it', async () => {
      // Re-pointing a healthy owned folder runs a deep reconcile that retires every catalog key
      // with no file behind it at the new path — a wrong pick empties the folder for every member.
      // The Change control belongs to the Locate flow, which only exists when the source is gone.
      const buttons = flatten(await A.snap()).filter((n) => n.role === 'button')
      assert(!buttons.some((b) => /^change$/i.test(b.label)), 'no Change button on a healthy source')
    })

    await r.ok('saving a new name renames the folder on screen', async () => {
      await A.type(NAME_FIELD, 'Olli’s Archive')
      await A.click({ role: 'button', contains: 'Save' })
      await waitFor(async () => {
        const text = allText(await A.snap())
        return /olli’s archive/i.test(text) && !/edit folder/i.test(text)
      }, 20000, 'the modal closes and the header carries the new name')
      await A.shot('s123-A-renamed', runDir)
    })

    await r.ok('reopening shows the saved name, not a stale draft', async () => {
      await A.click({ name: 'More' })
      await A.click({ contains: 'Edit Folder' })
      await A.waitText('Edit Folder', 15000)
      await waitFor(async () => {
        // `actionable` is load-bearing: agent-desktop 0.8.x gives the <label for> a ref of its own,
        // carrying the very same accessible name as the field it labels, and it comes first in
        // document order — a raw name match reads the label's empty value forever.
        const field = findNode(await A.snap(), { name: 'Folder name', actionable: true })
        return field?.value === 'Olli’s Archive'
      }, 15000, 'the field is seeded from the saved name')
      await A.press('escape')
      await A.shot('s123-A-reopened', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A] }
}
