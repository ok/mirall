import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

const sleep = (ms) => new Promise((res) => setTimeout(res, ms))

// FIX-REMOVE-1 — the owner removes a loose file mid-download, then re-adds the same content.
// The receiver must be TOLD the download stopped (a toast), and the file must come back as
// re-downloadable (remote) — never auto-resuming. The toast only fires while B is genuinely
// mid-download (a completed download is kept, not "removed"), so like s88/s90 this uses a
// 256 MB file to keep B comfortably mid-flight through the owner's unshare.
export default async function s102 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('remove-readd-')
  const big = path.join(dir, 'clip.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(256 * 1024 * 1024, 0x51))

  try {
    await r.ok('A shares a large loose file; B starts downloading it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(big)
      await A.waitText('clip.bin', 20000)
      await B.waitText('clip.bin', 60000)
      await B.waitText('Available', 90000)
      await B.click({ role: 'button', name: 'Download', last: true })
      await B.waitText('Downloading', 60000)
    })

    await r.ok('A removes the file mid-download → B is told, and the row clears', async () => {
      assert(!(await B.hasText('On your device')), 'precondition: B is still mid-download when A removes')
      await A.focus()
      await A.click({ role: 'button', name: 'Unshare from Space', last: true })
      await A.waitText('Remove', 8000)
      await A.click({ role: 'button', name: 'Remove File', last: true })
      await B.waitText('removed by the owner', 20000) // the mandatory "download stopped" toast
      await B.shot('s102-B-removed-toast', runDir)
      await waitFor(async () => !(await B.hasText('clip.bin')), 60000, 'file row clears for the peer')
    })

    await r.ok('A re-adds the same file → B sees it re-downloadable, not auto-resuming', async () => {
      await A.focus()
      await A.addFile(big)
      await A.waitText('clip.bin', 20000)
      await B.waitText('clip.bin', 60000)
      await B.waitText('Available', 90000) // back to remote — a fresh manual download is required
      assert(await B.has({ role: 'button', name: 'Download' }), 'the Download control is offered again (manual re-trigger)')
      await sleep(5000) // the buggy auto-resume would flip this to Downloading / On your device
      assert(!(await B.hasText('On your device')), 'the file did not auto-download after the re-add')
      assert(await B.has({ role: 'button', name: 'Download' }), 'still offered a manual Download, not resuming')
      await B.shot('s102-B-remote-after-readd', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
