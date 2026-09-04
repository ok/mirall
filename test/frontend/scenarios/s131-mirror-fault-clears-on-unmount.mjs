import { mkdirSync, writeFileSync, chmodSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor } from '../assert.mjs'
import { allText, flatten } from '../tree.mjs'
import { workDir } from '../paths.mjs'

// REGRESSION (ADOPT-A1: the mirror's durable record was read by a hand-rolled effect with no
// staleness guard AND an early return that did not clear. Unmounting the mirror flipped the share's
// role off 'mirrored', which handed the hook an empty shareId — so it returned without touching
// state and the fault strip went on rendering, Try again button and all, for a mount that no longer
// existed. Pressing that button sent foreign-folder:set-enabled for a shareId with no record.)
//
// The unmount does not leave the screen: ScreenRouter flips the selected share's role to 'browse'
// in place, so FolderView stays mounted with the same identity. That is precisely the case the
// hand-rolled hook could not clear, and why this is a screen test rather than a unit one.
//
// The fault is induced the only way a mirror's can be: the mirror writes into its own directory, so
// a directory it cannot write to fails the write and auto-pauses the mirror with paused-error.
export default async function s131 ({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Reports')
  mkdirSync(ownDir, { recursive: true })
  writeFileSync(path.join(ownDir, 'q1.txt'), 'numbers')

  const mirrorDir = path.join(workDir('mirror-'), 'Reports')
  mkdirSync(mirrorDir, { recursive: true })

  try {
    await r.ok('A shares a folder and B mirrors it', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
      await A.addOwnedFolder(ownDir)
      await A.waitText('Reports', 60000)
      await B.waitText('Reports', 60000)
      await B.mirrorShare(mirrorDir)
      await B.openFolder('Reports')
      await B.waitText('q1.txt', 60000)
    })

    await r.ok('a mirror that cannot write its own folder stops, and says so with a retry', async () => {
      chmodSync(mirrorDir, 0o555)
      writeFileSync(path.join(ownDir, 'q2.txt'), 'more numbers')
      await waitFor(async () => /syncing stopped/i.test(allText(await B.snap())), 120000,
        'the mirror fault strip names the stop')
      const buttons = flatten(await B.snap()).filter((n) => n.role === 'button')
      assert(buttons.some((b) => /^try again$/i.test(b.label)),
        'the strip carries its verb, addressable by role and accessible name')
      await B.shot('s131-mirror-fault', runDir)
    })

    await r.ok('unmounting the mirror clears the strip AND its retry, on the same screen', async () => {
      chmodSync(mirrorDir, 0o755)   // so the unmount itself cannot fail on the permission
      await B.unmountShare()
      await waitFor(async () => {
        const snap = await B.snap()
        const noStrip = !/syncing stopped/i.test(allText(snap))
        const noRetry = !flatten(snap).some((n) => n.role === 'button' && /^try again$/i.test(n.label))
        return noStrip && noRetry
      }, 60000, 'the fault strip and its Try again are both gone for a mount that no longer exists')
      await B.shot('s131-unmounted', runDir)
    })
  } catch {} finally {
    // Step 2 makes mirrorDir unwritable and step 3 restores it — but a failure in between (the
    // 120 s fault-strip wait timing out, say) skips step 3 entirely, and the children of a 0o555
    // directory cannot be unlinked. Without this, every failed run leaves its temp tree behind for
    // good. Idempotent with step 3's own restore.
    try { chmodSync(mirrorDir, 0o755) } catch {}
  }
  return { pass: r.summary(), instances: [A, B] }
}
