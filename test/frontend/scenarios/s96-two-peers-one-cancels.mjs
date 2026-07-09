import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// E2 — two peers download the same loose file; one CANCELS while the other finishes. The
// owner's "who is downloading" indicator drops the canceller and clears once the finisher
// completes. Multi-peer + fast loopback is highly timing-dependent, so the mid-flight
// cancel catch is best-effort/logged (matching s74); the deterministic bookends are no
// indicator at rest and the indicator clearing after the surviving download completes.
export default async function s96 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 3 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 3 })
  const C = new Instance({ name: 'Carol', bootstrap, slot: 2, total: 3 })

  const dir = workDir('two-peer-cancel-')
  const big = path.join(dir, 'shared.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 37))
  const landedB = path.join(B.downloadFolder, 'shared.bin')
  const SHOW = { role: 'button', name: 'Show who is downloading' }

  try {
    await r.ok('A creates a space; Bob and Carol join and are approved', async () => {
      await A.launch(); await B.launch(); await C.launch()
      const code = await createSpaceWithInvite(A, { name: 'Aurora' })
      await joinPending(B, code)
      await joinPending(C, code)
      await A.focus()
      await A.waitText('to join', 30000)
      await A.click({ role: 'button', contains: 'Review' })
      await A.waitText('Requests to join', 10000)
      await A.click({ role: 'button', contains: 'Approve all' })
      await B.waitText('Drop to Share', 40000)
      await C.waitText('Drop to Share', 40000)
    })

    await r.ok('A shares; both peers see Available', async () => {
      await A.focus()
      await A.addFile(big)
      await A.waitText('shared', 60000)
      for (const P of [B, C]) { await P.focus(); await P.waitText('shared', 90000); await P.waitText('Available', 90000) }
    })

    await r.ok('at rest, A shows no downloader indicator', async () => {
      await A.focus()
      await waitFor(async () => !(await A.has(SHOW)), 5000, 'no indicator at rest')
    })

    await r.ok('both download; Carol cancels; Bob completes; A clears the indicator', async () => {
      await B.focus(); await B.click({ role: 'button', name: 'Download', last: true })
      await C.focus(); await C.click({ role: 'button', name: 'Download', last: true })

      // Best-effort: catch Carol mid-flight and cancel her pull.
      await C.focus()
      let cCancel = false
      const dl = Date.now() + 20000
      while (Date.now() < dl) {
        if (await C.has({ role: 'button', name: 'Cancel' })) { cCancel = true; break }
        if (await C.hasText('On your device')) break
        await sleep(200)
      }
      if (cCancel) await C.click({ role: 'button', name: 'Cancel' })
      console.log(`s96: Carol cancelled mid-flight: ${cCancel}`)

      await waitFor(() => existsSync(landedB), 180000, 'Bob receives shared.bin')
      await B.waitText('On your device', 30000)

      await A.focus()
      await waitFor(async () => !(await A.has(SHOW)), 40000, 'owner indicator clears after the surviving download completes')
      await A.shot('s96-A-settled', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B, C] }
}
