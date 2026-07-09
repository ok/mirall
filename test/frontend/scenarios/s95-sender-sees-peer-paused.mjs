import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// E1 — the file OWNER's "who is downloading" indicator reflects a peer PAUSING mid-pull.
// While B downloads, A shows the downloader indicator (s73); when B pauses, A's indicator
// surfaces the paused peer ("N paused" / "Paused at N%"); when B resumes and finishes, the
// indicator clears. All timing-dependent (fast loopback), so — like s73 — the mid-flight
// catches are best-effort/logged; the deterministic bookend is the indicator clearing once
// B completes. The serve-ledger paused accounting is proven at integration/serve-ledger.
export default async function s95 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('sender-paused-')
  const big = path.join(dir, 'feed.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 31))
  const landed = path.join(B.downloadFolder, 'feed.bin')
  const SHOW = { role: 'button', name: 'Show who is downloading' }

  let sawIndicator = false
  let sawPaused = false
  try {
    await r.ok('A shares a big loose file; B sees it Available', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await A.waitText('feed', 60000)
      await B.waitText('feed', 90000)
      await B.waitText('Available', 90000)
    })

    await r.ok('B downloads then pauses; A reflects the paused peer when the race allows', async () => {
      await B.click({ role: 'button', name: 'Download', last: true })
      await A.focus()
      const dl = Date.now() + 25000
      while (Date.now() < dl) {
        if (await A.has(SHOW)) { sawIndicator = true; break }
        if (existsSync(landed)) break
        await sleep(200)
      }
      if (!sawIndicator) { console.log('s95: owner indicator not caught (loopback too fast)'); return }
      await A.shot('s95-A-indicator', runDir)

      await B.focus()
      if (!(await B.has({ role: 'button', name: 'Pause Download' }))) { console.log('s95: B past the pausable window'); return }
      await B.click({ role: 'button', name: 'Pause Download' })

      await A.focus()
      const pd = Date.now() + 15000
      while (Date.now() < pd) {
        if (await A.hasText('paused')) { sawPaused = true; break }
        if (!(await A.has(SHOW))) break // indicator cleared before the pause reflected
        await sleep(300)
      }
      if (sawPaused) await A.shot('s95-A-peer-paused', runDir)
      console.log(`s95: owner reflected a paused peer: ${sawPaused}`)

      await B.focus()
      if (await B.has({ role: 'button', name: 'Resume' })) await B.click({ role: 'button', name: 'Resume' })
    })

    await r.ok('B completes; A clears the downloader indicator', async () => {
      await waitFor(() => existsSync(landed), 180000, 'feed.bin lands on B')
      await B.waitText('On your device', 30000)
      await A.focus()
      await waitFor(async () => !(await A.has(SHOW)), 30000, 'owner indicator clears after completion')
      await A.shot('s95-A-settled', runDir)
    })

    console.log(`s95: indicator caught: ${sawIndicator}; paused reflected: ${sawPaused}`)
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
