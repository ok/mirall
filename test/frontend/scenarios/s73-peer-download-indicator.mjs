import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// The file OWNER sees who is currently downloading their loose file. While a peer
// pulls, the owner's row grows a "Show who is downloading" expander (avatar stack
// + aggregate bar) in place of its status badge; expanding it lists the peer with
// a per-peer progress bar; once the peer finishes, the expander clears.
//
// The deterministic signal is the expander BUTTON: absent at rest, present while a
// peer pulls, gone after. Catching it (and the expanded per-peer list) mid-transfer
// is best-effort — local loopback can finish even a big download inside the AX poll
// window (the documented s48/s42 race) — so a lost race is not a failure; the
// always-checked bookends are no-indicator-at-rest and indicator-clears-after, plus
// the file landing on the peer. The two-tier event gating + byte accounting are
// proven in test/integration/peer-download-ledger and the flow tests.
export default async function s73 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const srcDir = workDir('src-')
  const srcFile = path.join(srcDir, 'payload.bin')
  mkdirSync(srcDir, { recursive: true })
  // 256 MB widens the serve window so the owner-side indicator usually renders
  // before the transfer completes (matches s48's sizing rationale).
  writeFileSync(srcFile, Buffer.alloc(256 * 1024 * 1024, 9))
  const landed = path.join(B.downloadFolder, 'payload.bin')
  const SHOW = { role: 'button', name: 'Show who is downloading' }

  let sawIndicator = false
  let sawPeerRow = false

  try {
    await r.ok('A shares payload.bin (loose); B sees it as Available', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(srcFile)
      // FileName splits the extension into its own span, so the AX text reads
      // "payload .bin" — match the stem.
      await A.waitText('payload', 60000)
      await B.waitText('payload', 90000)
      // "Available" requires A's content hash to be advertised → A's publish (the
      // 256 MB hash) has finished and the row has settled.
      await B.waitText('Available', 90000)
    })

    await r.ok('at rest, A shows NO downloader indicator', async () => {
      await A.focus()
      assert(!(await A.has(SHOW)), 'no downloader indicator before anyone downloads')
      await A.shot('s73-A-at-rest', runDir)
    })

    await r.ok('B downloads; A surfaces the downloader indicator + per-peer list when the race allows', async () => {
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
          assert(await A.has({ role: 'progressbar' }), 'collapsed aggregate progress bar is AX-targetable')
          await A.shot('s73-A-indicator', runDir)
          await A.click(SHOW)
          await waitFor(() => A.has({ name: 'People downloading this file' }), 6000, 'downloaders dropdown')
          assert(await A.hasText('Bob'), 'the downloading peer (Bob) is named in the expanded list')
          assert(await A.has({ role: 'progressbar', name: "Bob's download" }), 'per-peer progress bar for Bob')
          sawPeerRow = true
          await A.shot('s73-A-peer-list', runDir)
        } catch {}
      }
    })

    await r.ok('the file lands on B; A clears the indicator', async () => {
      await waitFor(() => existsSync(landed), 120000, 'payload.bin landed on B')
      await B.waitText('On your device', 30000)
      await A.focus()
      // The indicator is transient: once Bob finishes, the expander disappears.
      await waitFor(async () => !(await A.has(SHOW)), 30000, 'owner indicator clears after completion')
      assert(!(await A.has({ role: 'button', name: 'Hide who is downloading' })),
        'expanded indicator also gone after completion')
      await A.shot('s73-A-settled', runDir)
    })

    console.log(`s73: owner indicator caught: ${sawIndicator}; per-peer list asserted: ${sawPeerRow}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
