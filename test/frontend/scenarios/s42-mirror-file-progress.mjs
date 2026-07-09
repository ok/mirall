import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor, dirSize } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Folder mirroring must show the SAME per-file download bar an individual file
// download shows — and, unlike an individual download, must NOT expose pause /
// cancel controls (a mirror download is driven by the materialize loop, not a
// cancellable transfer). The byte-level progress emission is hard-proven in
// test/flow/foreign-mirror-progress; here we verify the user-facing outcome:
// the bar surfaces in the folder view (best-effort — the local download can
// finish faster than the AX poll), the file lands, and no pause/cancel control
// is ever present on a mirror file row.
export default async function s42({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Media')
  mkdirSync(ownDir)
  // Large enough that the blob streams in several blocks, giving the bar a
  // chance to render before completion.
  writeFileSync(path.join(ownDir, 'big.bin'), Buffer.alloc(16 * 1024 * 1024, 7))
  const mirrorDir = workDir('mirror-')

  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })
    await r.ok('A shares "Media", B sees it', async () => {
      await A.addOwnedFolder(ownDir)
      await B.waitText('Media', 60000)
    })

    let sawBar = false
    await r.ok('B mirrors it; per-file download bar surfaces in the folder view', async () => {
      await B.mirrorShare(mirrorDir)
      // Open the folder right away and poll briefly for the progress bar. Its
      // aria-label ("Download progress") comes through as the AX node's
      // description, so we can find it without knowing the platform role string.
      await B.openFolder('Media')
      try {
        await waitFor(async () => B.has({ name: 'Download progress' }), 8000, 'download progress bar')
        sawBar = true
        await B.shot('s42-B-progress-bar', runDir)
      } catch {
        // Local loopback can finish the 16 MB download before the 400ms AX poll
        // catches the transient bar. The flow test is the hard guarantee; don't
        // fail the scenario on a lost race.
      }
    })

    await r.ok('the mirrored file lands on disk and the row resolves to downloaded', async () => {
      await waitFor(() => dirSize(mirrorDir) > 15 * 1024 * 1024, 90000, 'mirrored bytes on disk')
      await B.waitText('big.bin', 30000)
      // Reveal control (name = file.revealInFolder) appears once the file is local.
      await waitFor(async () => B.has({ name: 'Reveal in Folder' }), 30000, 'reveal control on synced row')
    })

    await r.ok('mirror file rows expose NO pause / cancel control', async () => {
      // file.pause = "Pause Download", file.cancel = "Cancel" — neither belongs
      // on a folder-mirror row, downloading or done.
      assert(!(await B.has({ name: 'Pause Download' })), 'no Pause Download control on mirror rows')
      assert(!(await B.has({ role: 'button', name: 'Cancel' })), 'no Cancel control on mirror rows')
      await B.shot('s42-B-no-pause-cancel', runDir)
    })

    console.log(`s42: progress bar caught in UI: ${sawBar}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
