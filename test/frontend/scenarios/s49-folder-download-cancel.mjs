import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Cancel mid-flight: row reverts to Available with a Download button, and the
// partial does not land at the destination. This is the FolderView equivalent
// of the FileCard cancel flow — same IPC, different surface, separate a11y
// guarantee per row.
export default async function s49 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Junkyard')
  mkdirSync(ownDir, { recursive: true })
  // 128 MB to give a comfortable mid-flight window.
  writeFileSync(path.join(ownDir, 'lump.bin'), Buffer.alloc(128 * 1024 * 1024, 13))

  let sawCancelButton = false

  try {
    await r.ok('A shares "Junkyard"; B opens the folder', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await B.waitText('Junkyard', 60000)
      await B.openFolder('Junkyard')
      await B.waitText('lump.bin', 20000)
    })

    await r.ok('B clicks Download then Cancel; row reverts to Available', async () => {
      await B.click({ role: 'button', name: 'Download' })

      const deadline = Date.now() + 15000
      while (Date.now() < deadline) {
        if (await B.has({ role: 'button', name: 'Cancel' })) {
          sawCancelButton = true
          break
        }
        if (await B.hasText('On your device')) break
        await new Promise((res) => setTimeout(res, 200))
      }
      assert(sawCancelButton, 'Cancel button is reachable by role+name during download')
      await B.shot('s49-B-cancel-visible', runDir)

      await B.click({ role: 'button', name: 'Cancel' })

      // Row reverts to Available with a Download button (cancel discards the
      // partial; no Resume/Discard affordance is offered because there is no
      // pending row to resume from).
      const reverted = Date.now() + 15000
      let backToAvailable = false
      while (Date.now() < reverted) {
        if (await B.has({ role: 'button', name: 'Download' }) && await B.hasText('Available')) {
          backToAvailable = true
          break
        }
        await new Promise((res) => setTimeout(res, 200))
      }
      assert(backToAvailable, 'row shows Available + Download after cancel')
      await B.shot('s49-B-cancelled', runDir)

      // Nothing landed.
      const landed = path.join(B.downloadFolder, 'lump.bin')
      assert(!existsSync(landed), 'no file landed at the destination after cancel')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
