import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { createSpaceWithInvite, joinPending } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// F1 [characterization] — with two peers mid-download, the owner UNSHARES the loose file.
// Neither peer falsely completes the removed content: no full file lands on either. The
// multi-peer extension of s88; same known gap (no loose TRANSFER_REMOVED terminal state), so
// the degraded peer state is logged, not asserted. 512 MB + an immediate unshare (no waiting
// on per-peer "Downloading" text) keeps both peers reliably mid-flight when the removal lands.
export default async function s97 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 3 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 3 })
  const C = new Instance({ name: 'Carol', bootstrap, slot: 2, total: 3 })

  const dir = workDir('two-peer-unshare-')
  const big = path.join(dir, 'group.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(512 * 1024 * 1024, 41))
  const landedB = path.join(B.downloadFolder, 'group.bin')
  const landedC = path.join(C.downloadFolder, 'group.bin')

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

    await r.ok('A shares; both peers start downloading', async () => {
      await A.focus()
      await A.addFile(big)
      await A.waitText('group', 60000)
      for (const P of [B, C]) { await P.focus(); await P.waitText('group', 90000); await P.waitText('Available', 90000) }
      // Kick off both downloads back-to-back, then only a short settle — no per-peer
      // "Downloading" wait — so both are still mid-flight when A unshares.
      await B.focus(); await B.click({ role: 'button', name: 'Download', last: true })
      await C.focus(); await C.click({ role: 'button', name: 'Download', last: true })
      await sleep(2500)
    })

    await r.ok('A unshares mid-download → neither peer completes the removed content', async () => {
      await A.focus()
      await A.click({ role: 'button', name: 'Unshare from Space', last: true })
      await A.waitText('Remove', 8000)
      await A.click({ role: 'button', name: 'Remove File', last: true })
      await waitFor(async () => !(await A.hasText('group')), 20000, 'owner row gone')
      await A.shot('s97-A-unshared', runDir)

      await sleep(15000)
      const bDone = existsSync(landedB)
      const cDone = existsSync(landedC)
      assert(!bDone, 'Bob never completes the removed content')
      assert(!cDone, 'Carol never completes the removed content')
      console.log(`s97: post-unshare — Bob complete: ${bDone}, Carol complete: ${cDone} (both expected false)`)
      await B.shot('s97-B-after-unshare', runDir)
      await C.shot('s97-C-after-unshare', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B, C] }
}
