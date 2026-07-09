import { mkdirSync, writeFileSync } from 'node:fs'
import path from 'node:path'
import { Instance } from '../instance.mjs'
import { connectInSpace } from '../helpers.mjs'
import { makeReport, assert, waitFor, dirSize } from '../assert.mjs'
import { workDir } from '../paths.mjs'

export default async function s6({ runDir, bootstrap }) {
  mkdirSync(runDir, { recursive: true })
  const r = makeReport()
  const A = new Instance({ name: 'Alice', bootstrap, slot: 0, total: 2 })
  const B = new Instance({ name: 'Bob', bootstrap, slot: 1, total: 2 })

  const ownDir = path.join(workDir('own-'), 'Media')
  mkdirSync(ownDir)
  writeFileSync(path.join(ownDir, 'big.bin'), Buffer.alloc(4 * 1024 * 1024, 7))
  writeFileSync(path.join(ownDir, 'note.txt'), 'hello')
  const mirrorDir = workDir('mirror-')

  try {
    await r.ok('launch + connect', async () => {
      await A.launch()
      await B.launch()
      await connectInSpace(A, B, { name: 'Aurora' })
    })
    await r.ok('A shares "Media", B sees it', async () => {
      await A.addOwnedFolder(ownDir)
      await B.waitText('Media', 60000)
    })
    await r.ok('B mirrors it to disk (files land, badge Mirrored)', async () => {
      await B.mirrorShare(mirrorDir)
      await waitFor(() => dirSize(mirrorDir) > 3 * 1024 * 1024, 90000, 'mirrored bytes on disk')
      await B.waitText('Mirrored', 30000)
      await B.shot('s6-B-mirrored', runDir)
    })
    // FIX-9's byte-level cache reclaim (storage:info per-space bytes drop on
    // unmount) is asserted in the backend flow test (test/flow/mirror-reclaim);
    // it isn't cleanly surfaced in the UI (the storage screen shows logical /
    // on-disk figures that don't drop promptly under rocksdb). Here we verify
    // the user-facing unmount outcome: the share reverts Mirrored -> Browse.
    // Pause/resume are new controls on the mirrored card. The menu offers
    // "Pause Mirror" only while enabled and "Resume Mirror" only while paused,
    // so pausing then resuming in sequence (each click resolves its labelled
    // control) proves the paused state surfaced and round-tripped. Backend
    // enabled/status transitions are asserted in test/integration/foreign-toggle.
    await r.ok('pause then resume the mirror (card shows a Paused badge)', async () => {
      await B.pauseMirror()                       // "Pause Mirror" must be present & clickable
      await B.waitText('Paused', 10000)            // the card badge reflects the paused state
      await B.shot('s6-B-paused', runDir)
      await B.resumeMirror()                       // "Resume Mirror" only exists once paused
      await waitFor(async () => !(await B.hasText('Paused')), 10000, 'paused badge cleared on resume')
    })
    await r.ok('unmount reverts the share to Browse', async () => {
      await B.unmountShare()
      await waitFor(async () => !(await B.hasText('Mirrored')), 30000, 'Mirrored badge to clear')
      assert(await B.hasText('Browse'), 'share did not revert to Browse')
      await B.shot('s6-B-unmounted', runDir)
    })
  } catch {}
  return { pass: r.summary(), instances: [A, B] }
}
