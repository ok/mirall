import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { workDir } from '../paths.mjs'

// FIX-M4 — a mirror demonstrably short of the owner's listing must not read "Up to date" while
// the owner is away, and the People card must not say the mirrorer is "Syncing…" when nothing is
// being fetched. Same rig as s138: Alice shares, Alice is killed, Bob mirrors and so holds none
// of the files.
//
// hasText is a case-folded whole-window substring. "Owner offline" also appears in every row's
// disabled download button label, so the pill is asserted through its accessible name
// ("Set: Owner offline"), which only the pill carries. "Up to date" and "Syncing…" appear on this
// screen only as the two labels being retired, so their absence is a whole-window claim.
const NAMES = Array.from({ length: 4 }, (_, i) => `track-${String(i + 1).padStart(2, '0')}.txt`)

export default async function s139({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Set')
  mkdirSync(ownDir, { recursive: true })
  for (const n of NAMES) writeFileSync(path.join(ownDir, n), 'x'.repeat(64))
  const mirrorDir = workDir('mirror-')

  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })

    await r.ok('A shares "Set" and B sees it', async () => {
      await A.addOwnedFolder(ownDir)
      await B.waitText('Set', 60000)
    })

    // Browsing pulls Alice's catalog onto Bob's disk, which is what the file count is read from.
    await r.ok('B browses the folder so the catalog replicates', async () => {
      await B.openFolder('Set')
      await B.waitText(NAMES[0], 60000)
    })

    await r.ok('Alice goes offline and Bob notices', async () => {
      await A.kill()
      await B.waitText('offline', 90000)
      await B.click({ name: 'Back' })
      await B.waitText('Set', 30000)
    })

    await r.ok('B mirrors the folder while its owner is away', async () => {
      await B.mirrorShare(mirrorDir)
      await B.openFolder('Set')
      await waitFor(() => B.hasText('Not available'), 60000, 'rows render as Not available')
    })

    await r.ok('the folder pill reads "Owner offline", not "Up to date"', async () => {
      await waitFor(() => B.hasText('Set: Owner offline'), 30000, 'the pill carries its folder-qualified name')
      assert(!(await B.hasText('Up to date')), '"Up to date" appears nowhere on the screen')
    })

    await r.ok('the People card reads "Waiting for owner", not "Syncing…"', async () => {
      await waitFor(() => B.hasText('Waiting for owner'), 30000, 'the mirrorer row reads as waiting')
      assert(!(await B.hasText('Syncing…')), '"Syncing…" appears nowhere on the screen')
    })

    await r.ok('the offline strip is still present — pill and strip agree', async () => {
      assert(await B.hasText('showing last synced files'), 'the offline strip is on screen')
      await B.shot('s139-B-mirror-offline-incomplete', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
