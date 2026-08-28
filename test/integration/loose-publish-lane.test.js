import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupOwnedShare } from '../helpers/owned.js'
import { initialPublishScan, stopOwnedFolder } from '../../src/shared/folders/owned-folders.js'
import { getOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initDownloads, getOwnedSourcePath } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import {
  initLooseOverlay, _resetLooseOverlay, looseShareFile, looseCancelPublish, looseSourceFor, looseSources,
  sweepLoosePresence, handleLooseFsEvent, LOOSE_SHARE_ID,
} from '../../src/shared/transfer/loose-overlay.js'
import { getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
async function until (fn, ms = 10000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (await fn()) return true
    await sleep(10)
  }
  return false
}

// prepareForServe is the single choke point for the streaming read every publish performs — loose
// or folder — so counting it counts real work on the shared lane.
function slowHash (t, ms, { only = null } = {}) {
  const overlay = getOverlay()
  const orig = overlay.prepareForServe.bind(overlay)
  const calls = []
  let live = 0
  let peak = 0
  overlay.prepareForServe = async (diskPath, opts) => {
    const name = path.basename(diskPath)
    calls.push(name)
    live += 1
    peak = Math.max(peak, live)
    try { if (!only || only.includes(name)) await sleep(ms); return await orig(diskPath, opts) } finally { live -= 1 }
  }
  t.teardown(() => { overlay.prepareForServe = orig })
  return { calls, peak: () => peak }
}

// A folder share and loose files in the SAME space, so both producers feed one lane.
async function setup (t, { concurrency = 2 } = {}) {
  const ctx = await setupOwnedShare(t)
  const cfg = getRuntimeConfig()
  setRuntimeConfig({ ...cfg, inPlaceFilesEnabled: true, publishConcurrency: concurrency })
  await initDownloads()
  await initPendingTransfers()
  looseSources.clear()
  initLooseOverlay(ctx.fake.ipc)
  t.teardown(() => { _resetLooseOverlay(); stopOwnedFolder(ctx.spaceId, ctx.share.id); setRuntimeConfig(cfg) })
  return ctx
}

const fill = (dir, names) => { for (const n of names) fs.writeFileSync(path.join(dir, n), 'x'.repeat(4096)) }
function writeSource (ctx, name, contents) {
  const abs = path.join(ctx.tmpDir('src'), name)
  fs.writeFileSync(abs, contents)
  return abs
}

// The point of the shared lane: a file the user drops in is INTERACTIVE and takes the express
// lane, while the folder backfill's BULK items hold every bulk slot. Before, the two were
// uncoordinated CPU consumers with no priority between them.
test('a loose drop starts at once while a folder backfill holds every bulk slot', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 1 })
  const seeds = ['s1.bin', 's2.bin', 's3.bin', 's4.bin']
  fill(ctx.mountPath, seeds)
  const probe = slowHash(t, 600, { only: seeds })

  const backfill = initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  await sleep(150)
  const abs = writeSource(ctx, 'drop.txt', 'dropped in')
  const t0 = Date.now()
  await looseShareFile(ctx.spaceId, abs, 'drop.txt')
  const took = Date.now() - t0
  t.ok(took < 500, 'published on the express lane, not after the backfill (' + took + 'ms)')
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'drop.txt'), 'and it is advertised')
  t.is(probe.calls.indexOf('drop.txt'), 1, 'the second read to start, right behind the file already in flight')
  await backfill
})

// withSpaceLock used to hold the whole hash, so three adds in one space ran one after another.
test('three files:add in one space no longer serialize behind each other\'s hash', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 2 })
  const probe = slowHash(t, 500)
  const names = ['a.txt', 'b.txt', 'c.txt']
  const files = names.map((n) => writeSource(ctx, n, n))
  const t0 = Date.now()
  await Promise.all(files.map((abs, i) => looseShareFile(ctx.spaceId, abs, names[i])))
  const took = Date.now() - t0
  t.ok(probe.peak() >= 2, 'at least two hashes overlapped — peak ' + probe.peak())
  t.ok(took < 1200, 'three 500 ms hashes finished well inside 1500 ms (' + took + 'ms)')
  for (const n of names) t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, n), n + ' advertised')
})

// A cancel of an item that never started runs no executor: the admission-time source link and
// tracking must still be dropped, or an unshared file keeps a dangling link forever.
test('cancelling a queued loose publish leaves no entry, no link and no tracking', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 1 })
  fill(ctx.mountPath, ['bulk.bin'])
  const probe = slowHash(t, 800, { only: ['bulk.bin', 'hold.txt'] })
  const backfill = initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])   // the bulk slot
  t.ok(await until(() => probe.calls.includes('bulk.bin')), 'precondition: the bulk slot is held')
  const hold = writeSource(ctx, 'hold.txt', 'h'.repeat(4096))
  const holding = looseShareFile(ctx.spaceId, hold, 'hold.txt')                       // the express lane
  t.ok(await until(() => probe.calls.includes('hold.txt')), 'precondition: the express lane is held')
  const second = writeSource(ctx, 'second.txt', 'queued behind both')
  const queued = looseShareFile(ctx.spaceId, second, 'second.txt')
  await sleep(30)
  t.ok(looseSourceFor(second, ctx.spaceId), 'precondition: admitted and tracked while queued')

  await looseCancelPublish(ctx.spaceId, '/second.txt')
  const outcome = await queued
  t.is(outcome.outcome, 'cancelled')
  t.absent(probe.calls.includes('second.txt'), 'never read')
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'second.txt'), 'no entry')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/second.txt'), null, 'no dangling source link')
  t.absent(looseSourceFor(second, ctx.spaceId), 'no tracking')
  await Promise.all([holding, backfill])
})

// A retire that is queued behind held slots is left to the queue: the sweep neither races it nor
// duplicates it, and the entry goes exactly once, when the slot frees.
test('the sweep leaves a path with a queued retire alone; the retire runs once the slot frees', { timeout: 60000 }, async (t) => {
  const ctx = await setup(t, { concurrency: 1 })
  const abs = writeSource(ctx, 'gone.txt', 'bye')
  await looseShareFile(ctx.spaceId, abs, 'gone.txt')
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt'), 'precondition: published')

  fill(ctx.mountPath, ['bulk.bin'])
  const probe = slowHash(t, 900, { only: ['bulk.bin', 'hold.txt'] })
  const backfill = initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])
  t.ok(await until(() => probe.calls.includes('bulk.bin')), 'precondition: the bulk slot is held')
  const hold = writeSource(ctx, 'hold.txt', 'h'.repeat(4096))
  const holding = looseShareFile(ctx.spaceId, hold, 'hold.txt')
  t.ok(await until(() => probe.calls.includes('hold.txt')), 'precondition: the express lane is held')
  fs.unlinkSync(abs)
  const retire = handleLooseFsEvent({ spaceId: ctx.spaceId, absPath: abs, action: 'unlink' })
  await sleep(30)
  await sweepLoosePresence()
  await sweepLoosePresence()
  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt'), 'two sweeps did not act on a path whose retire is queued')

  await retire
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'gone.txt'), 'the queued retire removed it once it ran')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/gone.txt'), null)
  await Promise.all([holding, backfill])
})
