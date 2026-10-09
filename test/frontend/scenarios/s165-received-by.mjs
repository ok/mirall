import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// Once a member has downloaded a file, its owner's row keeps saying so: the live "who is
// downloading" indicator clears, and the resting row names who has it, which opens the list
// grouped as Have it / Not yet. The notification settings carry the four grouped sections, with
// join requests on and presence off by default.
export default async function s165({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const srcDir = workDir('src-')
  const srcFile = path.join(srcDir, 'report.bin')
  mkdirSync(srcDir, { recursive: true })
  writeFileSync(srcFile, Buffer.alloc(4 * 1024 * 1024, 7))
  const HAVE = { role: 'button', name: 'Bob has it' }

  try {
    await r.ok('A shares report.bin; before anyone downloads, the row says nothing about recipients', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addFile(srcFile)
      await A.waitText('report', 60000)
      await waitFor(() => B.has({ name: 'report.bin: Available' }), 90000, "B's row turns Available")
      assert(!(await A.has({ role: 'button', contains: 'have it' })), 'no recipients cluster at zero')
    })

    await r.ok('Bob downloads it; A row then reads "Bob has it"', async () => {
      await B.click({ role: 'button', name: 'Download', last: true })
      await waitFor(() => existsSync(path.join(B.downloadFolder, 'report.bin')), 120000, 'Bob received report.bin')
      await waitFor(() => A.has(HAVE), 60000, 'owner row shows who has the file')
      await A.shot('s165-A-collapsed', runDir)
    })

    await r.ok('the toggle opens the grouped list naming Bob', async () => {
      await A.click(HAVE)
      await waitFor(() => A.has({ name: 'People and this file' }), 8000, 'recipients region')
      await A.waitText('Bob has it, received', 8000)
      assert(await A.has(HAVE), 'the toggle keeps its name while open')
      await A.shot('s165-A-expanded', runDir)
    })

    await r.ok('notification settings are grouped, with the new defaults', async () => {
      await A.gotoSettings('Notifications')
      for (const heading of ['People', 'Shared with you', 'Your shared files', 'Your downloads']) await A.waitText(heading, 8000)
      assert((await A.nodeValue({ name: 'Join requests' })) === '1', 'join requests on by default')
      assert((await A.nodeValue({ name: 'Someone comes or goes' })) === '0', 'presence off by default')
      const before = await A.nodeValue({ name: 'Someone got your file' })
      await A.click({ name: 'Someone got your file' })
      await waitFor(async () => (await A.nodeValue({ name: 'Someone got your file' })) !== before, 8000, 'received switch flips')
      await A.shot('s165-A-settings', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
