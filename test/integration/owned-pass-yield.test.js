import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare, listRelPaths } from '../helpers/owned.js'
import { getOwnedMount } from '../../src/shared/folders/mount-store.js'
import { getIndexStatus, cancelIndex } from '../../src/shared/folders/owned-folders.js'
import { runPublishPass, passLiveness } from '../../src/shared/folders/owned-pass.js'
import { getPublishScheduler } from '../../src/shared/folders/publish-service.js'
import { getOwnEntry } from '../../src/shared/shares/own-catalog.js'
import { overlayHashFile } from '../../src/shared/transfer/overlay/overlay-hash.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { yieldToLoop } from '../../src/shared/core/loop-budget.js'

// The publish pass cedes the event loop on a time budget. A budget of 0 is spent at every
// checkpoint, so under it the pass cedes before every file in every phase: a folder of a few
// hundred files spans thousands of yield points on any machine, with no timing in the assertions.
// The folder is larger than one enqueue slice, so the diff reaches the lane through a sliced fill.

const FILES = 520
const fileNames = (n) => Array.from({ length: n }, (_, i) => `d${String(i % 8)}/f${String(i).padStart(4, '0')}.txt`)
const manyFiles = (n) => Object.fromEntries(fileNames(n).map((name, i) => [name, `content of file ${i}`]))

function cedeEverywhere(t) {
  const before = getRuntimeConfig()
  setRuntimeConfig({ ...before, loopYieldBudgetMs: 0 })
  t.teardown(() => setRuntimeConfig(before))
}

// Counts the slices a pass hands to the lane, and lets a test act between two of them.
function watchFills(t, afterAdd = () => {}) {
  const scheduler = getPublishScheduler()
  const original = scheduler.beginFill
  const seen = { fills: 0, slices: 0 }
  scheduler.beginFill = (...args) => {
    const fill = original(...args)
    seen.fills += 1
    return { add(specs) { fill.add(specs); seen.slices += 1; afterAdd(seen) }, end: () => fill.end() }
  }
  t.teardown(() => { scheduler.beginFill = original })
  return seen
}

// Runs `act` once, at a cede the pass takes inside its diff: every beat after the last file of the
// walk was read is the catalog side or a diff cede, and the catalog side beats only a handful of
// times, so the twentieth of them is well inside the diff and far from its end.
function atDiffCede(t, ctx, act) {
  const origStat = fs.statSync
  const origProgress = passLiveness.progress
  let walked = 0
  let beatsAfterWalk = 0
  let acted = false
  fs.statSync = (p) => { if (String(p).startsWith(ctx.mountPath + path.sep)) walked += 1; return origStat(p) }
  passLiveness.progress = (...args) => {
    origProgress(...args)
    if (walked < FILES || acted) return
    beatsAfterWalk += 1
    if (beatsAfterWalk === 20) { acted = true; act() }
  }
  t.teardown(() => { fs.statSync = origStat; passLiveness.progress = origProgress })
  return { acted: () => acted }
}

test('a pass that cedes at every file publishes, retires and settles exactly as an uninterrupted one', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(FILES) })
  const { spaceId, share, mountPath } = ctx
  cedeEverywhere(t)
  const fills = watchFills(t)
  let turns = 0
  let running = true
  const spin = async () => { while (running) { await yieldToLoop(); turns += 1 } }
  const spinning = spin()

  const first = await runPublishPass(spaceId, share.id, mountPath, [])
  const turnsDuringFirst = turns
  t.is(first.uploaded, FILES, 'every file is published')
  t.is(first.deleted, 0)
  t.is(first.failed, 0)
  t.is(first.totalOnDisk, FILES)
  t.alike(await listRelPaths(share, spaceId), fileNames(FILES).sort(), 'the catalog lists exactly the folder')
  t.is(fills.fills, 1, 'the diff was handed over through one sliced fill')
  t.is(fills.slices, 2, 'in two slices')
  t.ok(turnsDuringFirst >= FILES, `other work ran throughout the pass (${turnsDuringFirst} turns of the event loop)`)

  const names = fileNames(FILES)
  for (const name of names.slice(0, 3)) fs.writeFileSync(path.join(mountPath, ...name.split('/')), 'edited, and longer than before')
  for (const name of names.slice(10, 14)) fs.unlinkSync(path.join(mountPath, ...name.split('/')))
  fs.writeFileSync(path.join(mountPath, 'new-a.txt'), 'new a')
  fs.writeFileSync(path.join(mountPath, 'd1', 'new-b.txt'), 'new b')

  const second = await runPublishPass(spaceId, share.id, mountPath, [])
  t.is(second.uploaded, 5, 'three edits and two new files')
  t.is(second.deleted, 4, 'four retires')
  t.is(second.totalOnDisk, FILES - 4 + 2)
  const expected = [...names.slice(0, 10), ...names.slice(14), 'new-a.txt', 'd1/new-b.txt'].sort()
  t.alike(await listRelPaths(share, spaceId), expected, 'the catalog follows the disk')
  const edited = await getOwnEntry(spaceId, share.id, names[0])
  t.is(edited.contentHash, await overlayHashFile(path.join(mountPath, ...names[0].split('/'))), 'an edited file carries its new hash')

  const third = await runPublishPass(spaceId, share.id, mountPath, [])
  running = false
  await spinning
  t.is(third.uploaded, 0, 'a repeat pass over an unchanged folder publishes nothing')
  t.is(third.deleted, 0)
  t.is(third.totalOnDisk, FILES - 4 + 2)
})

test('a stop that lands while the diff is ceded ends the pass before anything is enqueued', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(FILES) })
  cedeEverywhere(t)
  const fills = watchFills(t)
  const scheduler = getPublishScheduler()
  let began = 0
  const origBegin = scheduler.beginShare
  scheduler.beginShare = (...args) => { began += 1; return origBegin(...args) }
  t.teardown(() => { scheduler.beginShare = origBegin })
  const hook = atDiffCede(t, ctx, () => cancelIndex(ctx.spaceId, ctx.share.id))

  const r = await runPublishPass(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  t.ok(hook.acted(), 'precondition: the stop landed at a cede inside the diff')
  t.ok(r.cancelled, 'the pass reports a cancel')
  t.is(r.totalOnDisk, 0)
  t.is(began, 0, 'the pass never opened its tally')
  t.is(fills.fills, 0, 'and handed nothing to the lane')
  const status = getIndexStatus(ctx.spaceId, ctx.share.id)
  t.is(status.queued + status.running + status.adding, 0, 'nothing is queued behind the stop')
  t.alike(await listRelPaths(ctx.share, ctx.spaceId), [], 'and nothing was published')
  t.absent((await getOwnedMount(ctx.spaceId, ctx.share.id)).indexPaused, 'a stop records no pause')
})

test('a pause that lands while the diff is ceded is not overwritten by the enqueue', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(FILES) })
  cedeEverywhere(t)
  const fills = watchFills(t)
  let pausing = null
  const hook = atDiffCede(t, ctx, () => { pausing = ctx.root.mounts.pauseIndex(ctx.spaceId, ctx.share.id) })

  const r = await runPublishPass(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  await pausing

  t.ok(hook.acted(), 'precondition: the pause started at a cede inside the diff')
  t.is(r.skipped, 'index-paused', 'the pass reports the pause, not a finished scan')
  t.is(fills.fills, 0, 'it enqueued nothing after the pause emptied the queue')
  t.ok((await getOwnedMount(ctx.spaceId, ctx.share.id)).indexPaused, 'the pause is on the record')
  const status = getIndexStatus(ctx.spaceId, ctx.share.id)
  t.is(status.queued + status.running + status.adding, 0, 'the lane holds nothing of the paused folder')
  t.alike(await listRelPaths(ctx.share, ctx.spaceId), [], 'and nothing was published')
})

test('a stop that lands between two slices of the enqueue leaves nothing queued', async (t) => {
  const ctx = await setupOwnedShare(t, { files: manyFiles(FILES) })
  cedeEverywhere(t)
  // The stop arrives with the first slice admitted and the pass about to cede before the second.
  const fills = watchFills(t, (seen) => { if (seen.slices === 1) cancelIndex(ctx.spaceId, ctx.share.id) })

  const r = await runPublishPass(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  t.is(fills.slices, 1, 'the second slice was not admitted behind the stop')
  t.ok(r.cancelled, 'the pass reports a cancel')
  const status = getIndexStatus(ctx.spaceId, ctx.share.id)
  t.is(status.queued + status.running + status.adding, 0, 'the stop emptied the first slice and nothing refilled the lane')
  t.alike(await listRelPaths(ctx.share, ctx.spaceId), [], 'nothing was published')

  const again = await runPublishPass(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.is(again.uploaded, FILES, 'and the next pass publishes the folder in full')
})
