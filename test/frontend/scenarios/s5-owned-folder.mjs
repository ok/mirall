import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert } from '../assert.mjs'
import { workDir } from '../paths.mjs'

export default async function s5({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const base = workDir('own-')
  const ownDir = path.join(base, 'Photos')
  mkdirSync(ownDir)
  writeFileSync(path.join(ownDir, 'a.txt'), 'AAA')
  writeFileSync(path.join(ownDir, 'b.txt'), 'BBB')

  try {
    await r.ok('launch A + B', async () => {
      await A.launch()
      await B.launch()
    })
    await r.ok('connect in space', async () => {
      await connectInSpace(A, B, { name: 'Aurora' })
    })
    await r.ok('A shares an owned folder (native folder picker)', async () => {
      await A.addOwnedFolder(ownDir)
      await A.waitText('Photos', 20000)
      // The Space Storage widget counts folder shares (not just loose files):
      // a.txt + b.txt = 6 bytes, owned → fully on this device.
      await A.waitText('6 B', 20000)
      await A.shot('s5-A-shared', runDir)
    })
    await r.ok('B receives the replicated folder', async () => {
      await B.waitText('Photos', 60000)
      // A browse-only share counts toward B's space total too.
      await B.waitText('6 B', 20000)
      await B.shot('s5-B-replicated', runDir)
    })
    // REGRESSION (FIX-2: owner-side file badge): when the owner opens their own
    // shared folder, each file is "Shared by you" — not "On your device". The
    // backend reports these files as 'synced' (same value a mirrored peer file
    // gets), so the label must be chosen from ownership, not status alone.
    await r.ok('REGRESSION (FIX-2): owner sees "Shared by you" on their own files', async () => {
      await A.openFolder('Photos')
      await A.waitText('a.txt', 20000)
      assert(await A.hasText('Shared by you'), 'owned file not labelled "Shared by you"')
      assert(!(await A.hasText('On your device')), 'owned file wrongly labelled "On your device"')
      await A.shot('s5-A-owner-file-badge', runDir)
      await A.back()
    })
    // REGRESSION: re-adding the same (already-shared) folder must explain WHY in
    // plain language — previously the modal showed only the raw overlapping path
    // (MOUNT_OVERLAPS' message is the path), so the user saw red text with no
    // reason. Assert a human sentence ("already") appears and the path picked is
    // not the only thing shown.
    await r.ok('REGRESSION: re-adding an already-shared folder shows a clear reason', async () => {
      await A.openAddFolderAndPick(ownDir)
      assert(await A.hasText('already'), 'overlap error not surfaced in plain language')
      await A.shot('s5-A-overlap-error', runDir)
      await A.click({ role: 'button', name: 'Cancel' })
    })
    await r.ok('FIX-1: A leaves with the folder mounted — no crash', async () => {
      await A.leaveSpace()
      assert(await A.hasText('Create Space'), 'did not return to Shared Spaces after leave')
      await A.shot('s5-A-after-leave', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
