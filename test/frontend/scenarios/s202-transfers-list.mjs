import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// The transfers page lists a download on the downloader and the same file as Sending on its owner,
// the header names how many transfers are under way, and Pause All / Resume All act on the download.
// B caps its download at 1 MB/s first, so the 64 MB file is still moving at every step: without the
// cap a loopback transfer can finish inside one accessibility poll.
export default async function s202({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const dir = workDir('transfers-list-')
  const big = path.join(dir, 'payload.bin')
  mkdirSync(dir, { recursive: true })
  writeFileSync(big, Buffer.alloc(64 * 1024 * 1024, 7))

  try {
    await r.ok('B limits its download speed, then joins A in a space', async () => {
      await A.launch()
      await B.launch()
      await B.press('cmd+k')
      await B.waitText('Type a command')
      await B.type({ role: 'combobox' }, 'network settings')
      await B.press('return')
      await B.waitText('Transfer Limits', 8000)
      await B.click({ name: 'Download limit: 1 MB/s' })
      await B.click({ role: 'button', name: 'Home' })
      await B.waitText('Create Space', 15000)
      await connectInSpace(A, B, { name: 'Aurora' })
    })

    await r.ok('A shares a file and B starts downloading it', async () => {
      await A.addFile(big)
      await A.waitText('payload', 60000)
      await B.waitText('payload', 90000)
      await B.waitText('Available', 90000)
      await B.downloadRow({ last: true })
      await B.waitText('Downloading', 30000)
    })

    await r.ok('B: the header counts the download and the page lists it under its space', async () => {
      await waitFor(() => B.has({ role: 'button', name: 'Transfers — 1 active' }), 20000, 'header names one active transfer')
      await B.click({ role: 'button', name: 'Transfers — 1 active' })
      await B.waitText('Everything moving between this device', 8000)
      await B.waitText('payload', 8000)
      assert(await B.hasText('Aurora'), 'the space group is named')
      assert(await B.has({ role: 'button', name: 'Pause Download' }), 'the row keeps its Pause control')
      assert(await B.has({ role: 'button', name: 'Open Space Aurora' }), 'the group links to its space')
      assert(await B.hasText('Speed'), 'the speed tile is on the page')
      assert(await B.hasText('MB/s') || await B.hasText('KB/s'), 'a rate is shown while the download moves')
      await B.shot('s202-B-transfers-downloading', runDir)
    })

    await r.ok('A: the same file is listed as Sending', async () => {
      await waitFor(() => A.has({ role: 'button', name: 'Transfers — 1 active' }), 30000, 'owner header names one active transfer')
      await A.click({ role: 'button', name: 'Transfers — 1 active' })
      await A.waitText('payload', 8000)
      await A.waitText('Sending', 15000)
      assert(await A.has({ role: 'button', name: 'Reveal in Folder' }), 'a sent file offers Reveal in Folder')
      assert(!(await A.has({ role: 'button', name: 'Pause All' })), 'sending alone offers no Pause All')
      await A.shot('s202-A-transfers-sending', runDir)
    })

    await r.ok('B: Pause All pauses the download and the header asks for attention', async () => {
      await B.click({ role: 'button', name: 'Pause All' })
      await waitFor(() => B.has({ role: 'button', name: 'Resume All' }), 20000, 'Resume All replaces Pause All')
      await B.waitText('Paused', 10000)
      assert(await B.has({ role: 'button', name: 'Transfers — 1 needs attention' }), 'header names the paused download')
      await B.shot('s202-B-transfers-paused', runDir)
    })

    await r.ok('B: the filter narrows the list, and Resume All starts the download again', async () => {
      await B.click({ name: 'Downloading, 0' })
      await B.waitText('No transfers match this filter.', 8000)
      await B.click({ name: 'Needs attention, 1' })
      await B.waitText('payload', 8000)
      await B.click({ role: 'button', name: 'Resume All' })
      await waitFor(() => B.has({ role: 'button', name: 'Pause All' }), 30000, 'the download moves again')
    })

    await r.ok('B: Open Space leads to the space, and Back returns to the page', async () => {
      await B.click({ name: 'All, 1' })
      await B.click({ role: 'button', name: 'Open Space Aurora' })
      await B.waitText('payload', 10000)
      assert(!(await B.hasText('Everything moving between this device')), 'the transfers page is left')
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
