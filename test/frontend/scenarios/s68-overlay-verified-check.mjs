import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, waitFor, dirSize, assert } from '../assert.mjs'
import { flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// Overlay "verified" indicator. A shares a folder "In place" (overlay); B mirrors
// it to disk. Each file's content hash is verified incrementally on download, so
// the folder view shows a "Verified" check next to the reveal icon. Asserting it
// by its accessible name (role-independent, distinctive aria-label substring) is
// also the a11y check — agent-desktop can target it, so a screen reader announces it.
export default async function s68 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Vault')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'report.txt'), 'overlay verified contents')
  const mirrorDir = workDir('mirror-')

  try {
    await r.ok('A shares "Vault" in place (overlay); B sees it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.openAddFolderModal(ownDir)
      // Overlay is the only content mode now — no picker; the share publishes in place.
      await A._confirmPreview('Add Folder', 'Upload')
      await A.waitText('Vault', 20000)
      await B.waitText('Vault', 60000)
    })
    await r.ok('B mirrors the overlay folder to disk (bytes land)', async () => {
      await B.mirrorShare(mirrorDir)
      await waitFor(() => dirSize(mirrorDir) > 0, 90000, 'mirrored overlay bytes on disk')
      await B.waitText('Mirrored', 30000)
    })
    await r.ok('the mirrored file row shows a named "Verified" check', async () => {
      await B.openFolder('Vault')
      await B.waitText('report.txt', 20000)
      await waitFor(() => B.has({ contains: 'content hash matches' }), 30000,
        'verified check rendered + accessibly named on the mirrored file row')
      await B.shot('s68-B-verified-check', runDir)
    })
    await r.ok('layout: verified badge sits left of the status pill (actions on the right)', async () => {
      await B.waitText('On your device', 30000)
      const nodes = flatten(await B.snap())
      const text = (n) => `${n.name} ${n.description} ${n.value}`.toLowerCase()
      const vIdx = nodes.findIndex((n) => text(n).includes('content hash matches'))
      const pIdx = nodes.findIndex((n) => text(n).includes('on your device'))
      assert(vIdx >= 0 && pIdx >= 0, 'verified badge + "On your device" pill present')
      assert(vIdx < pIdx, `verified badge (${vIdx}) is before the status pill (${pIdx})`)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
