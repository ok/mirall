import { mkdirSync, writeFileSync, existsSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// Defect 11 through the UI: a file downloaded out of a FOLDER share left no trace in the Activity
// Log at all, while the same download of a space-root file recorded one. The row's meta line has to
// name the folder as well as the space, or a folder row is indistinguishable from a loose one.
export default async function s125 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Brand Assets')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'logo.txt'), 'the mark'.repeat(64))

  try {
    await r.ok('A shares "Brand Assets"; B sees it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      // s124's idiom: bring A forward explicitly before the native Add-Folder trigger rather
      // than relying on press()'s is_focused short-circuit after a multi-peer handshake.
      await A.focus()
      await A.addOwnedFolder(ownDir)
      await A.waitText('Brand Assets', 60000)
      await B.waitText('Brand Assets', 60000)
    })

    await r.ok('B downloads a file out of the folder', async () => {
      await B.focus()
      await B.openFolder('Brand Assets')
      await B.waitText('logo.txt', 20000)
      await B.click({ role: 'button', name: 'Download' })
      await waitFor(() => existsSync(path.join(B.downloadFolder, 'logo.txt')), 60000, 'logo.txt downloaded')
      await B.waitText('On your device', 20000)
    })

    await r.ok('the download appears in the Activity Log', async () => {
      await B.openActivityLog()
      await B.waitText('logo.txt', 20000)
      await B.shot('s125-folder-download-row', runDir)
    })

    // The folder segment on the meta line is the only part of the audit change a user can see.
    await r.ok('the row names the folder as well as the space', async () => {
      // Assert the DOWNLOAD row's own meta line, not merely that the string exists somewhere:
      // 'Brand Assets' also appears in the "Alice shared the folder Brand Assets" row above, so a
      // bare substring search passes even when the segment under test is missing entirely.
      const nodes = flatten(await B.snap()).map((n) => n.name || n.value || '')
      assert(nodes.some((n) => n.includes('You downloaded logo.txt')), 'the download row names the file')
      assert(
        nodes.some((n) => n.startsWith('Aurora · Brand Assets')),
        'and its meta line names the space AND the folder — without the folder a folder row reads exactly like a loose one'
      )
    })

    await r.ok('the row is a Files row, not a Security one', async () => {
      await B.click({ role: 'checkbox', name: 'Files' })
      await B.waitText('logo.txt', 10000)
      await B.click({ name: 'Clear all' })
      await B.click({ role: 'checkbox', name: 'Security' })
      // Wait for the filtered list to settle on its empty state before asserting an ABSENCE —
      // hasText snapshots immediately, so without this it races the re-render and the row is
      // still on screen from the previous filter.
      await B.waitText('No events match', 10000)
      assert(!(await B.hasText('logo.txt')), 'a completed download is not a security event')
      await B.shot('s125-security-filter-empty', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
