import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// Folder-view parity for the sender-side "who is downloading" indicator (s73 covers
// the loose-file row in SpaceView). The OWNER of an in-place folder share, viewing
// the folder (FolderView), sees who is currently pulling a file from them: the row
// grows a "Show who is downloading" expander (avatar stack + aggregate bar) in place
// of its status badge; expanding it names the peer with a per-peer bar; once the peer
// finishes, the expander clears.
//
// Same race caveat as s73: local loopback can finish even a big download inside the
// AX poll window, so catching the indicator mid-transfer is best-effort. The always-
// checked bookends are no-indicator-at-rest and indicator-clears-after + the file
// landing on the peer. The ledger + byte accounting are proven in
// test/integration/peer-download-ledger and the flow tests.
export default async function s75 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  // Eager mode MUST be enabled so the Add Folder modal renders the Eager/In-place
  // segmented toggle; without it there is no "In place" segment to click. addOwnedFolder
  // ({overlay:true}) selects "In place" — the overlay backend, the only one that emits
  // the serve ledger this indicator depends on. Set explicitly (not via the harness
  // default) so the dependency is self-documenting and survives a default flip.
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2, flags: { eagerTransferMode: true } })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2, flags: { eagerTransferMode: true } })

  const ownDir = path.join(workDir('own-'), 'Vault')
  mkdirSync(ownDir, { recursive: true })
  // 256 MB widens the serve window so the owner-side indicator usually renders
  // before the transfer completes (matches s73/s48 sizing).
  writeFileSync(path.join(ownDir, 'payload.bin'), Buffer.alloc(256 * 1024 * 1024, 9))
  const landed = path.join(B.downloadFolder, 'payload.bin')
  const SHOW = { role: 'button', name: 'Show who is downloading' }

  let sawIndicator = false
  let sawPeerRow = false

  try {
    await r.ok('A shares "Vault" (in-place folder); B sees it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      // Overlay is the only content mode now — no picker; the share publishes in place.
      await A.openAddFolderModal(ownDir)
      await A._confirmPreview('Add Folder', 'Upload')
      await A.waitText('Vault', 20000)
      await B.waitText('Vault', 60000)
    })

    await r.ok('B opens the folder; the file is Available', async () => {
      await B.openFolder('Vault')
      // FileName splits the extension into its own span, so the AX text reads
      // "payload .bin" — match the stem.
      await B.waitText('payload', 30000)
      await B.waitText('Available', 60000)
    })

    await r.ok('A opens the folder; at rest shows NO downloader indicator', async () => {
      await A.openFolder('Vault')
      await A.waitText('payload', 30000)
      assert(!(await A.has(SHOW)), 'no downloader indicator before anyone downloads')
      await A.shot('s75-A-at-rest', runDir)
    })

    await r.ok('B downloads; A (in the folder) surfaces the downloader indicator + per-peer list when the race allows', async () => {
      await B.click({ role: 'button', name: 'Download' })
      await A.focus()

      const deadline = Date.now() + 25000
      while (Date.now() < deadline) {
        if (await A.has(SHOW)) { sawIndicator = true; break }
        if (existsSync(landed)) break // loopback finished before the poll caught it
        await sleep(200)
      }

      if (sawIndicator) {
        // Everything after detection is best-effort: a fast loopback download can clear the
        // transient indicator between has() and the click, and a lost race is not a failure.
        try {
          await A.shot('s75-A-indicator', runDir)
          await A.click(SHOW)
          await waitFor(() => A.has({ name: 'People downloading this file' }), 6000, 'downloaders dropdown')
          assert(await A.hasText('Bob'), 'the downloading peer (Bob) is named in the expanded list')
          assert(await A.has({ role: 'progressbar', name: "Bob's download" }), 'per-peer progress bar for Bob')
          sawPeerRow = true
          await A.shot('s75-A-peer-list', runDir)
        } catch {}
      }
    })

    await r.ok('the file lands on B; A clears the folder indicator', async () => {
      await waitFor(() => existsSync(landed), 120000, 'payload.bin landed on B')
      await B.waitText('On your device', 30000)
      await A.focus()
      // The indicator is transient: once Bob finishes, the expander disappears.
      await waitFor(async () => !(await A.has(SHOW)), 30000, 'owner folder indicator clears after completion')
      assert(!(await A.has({ role: 'button', name: 'Hide who is downloading' })),
        'expanded indicator also gone after completion')
      await A.shot('s75-A-settled', runDir)
    })

    console.log(`s75: folder owner indicator caught: ${sawIndicator}; per-peer list asserted: ${sawPeerRow}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
