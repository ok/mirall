import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { advertise, getOwnEntry } from '../../src/shared/shares/share-catalog.js'
import { serveIndex } from '../../src/shared/transfer/backends/overlay/overlay-serve-index.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initDownloads, markOwnedSource, getOwnedSourcePath } from '../../src/shared/transfer/files.js'
import { initPendingTransfers } from '../../src/shared/transfer/pending-transfers.js'
import {
  initLooseOverlay, _resetLooseOverlay, looseShareFile, looseCancelPublish,
  rehydrateLooseFiles, sweepLoosePresence, LOOSE_SHARE_ID,
} from '../../src/shared/transfer/loose-overlay.js'

// Big enough that the content hash takes visibly longer than a bee read, so the
// advertise-time window is observable without racing the whole publish.
const BIG = 32 * 1024 * 1024

async function setup (t, onEmit) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: true, inPlaceFilesEnabled: true })
  await initDownloads()
  await initPendingTransfers()
  serveIndex._reset()
  await initOverlay()
  initLooseOverlay({
    ...ctx.fake.ipc,
    emit: (type, payload) => { ctx.fake.ipc.emit(type, payload); onEmit?.(type, payload) },
  })
  const space = await createSpace('Aurora')
  t.teardown(async () => {
    _resetLooseOverlay()
    serveIndex._reset()
    await teardownOverlay()
    setRuntimeConfig({ ...getRuntimeConfig(), overlayEnabled: false, inPlaceFilesEnabled: false })
  })
  return { ...ctx, spaceId: space.spaceId }
}

function writeBig (ctx, name) {
  const abs = path.join(ctx.tmpDir('src'), name)
  fs.writeFileSync(abs, Buffer.alloc(BIG, 0x61))
  return abs
}

// The post-restart state a quit-mid-hash leaves: an advertised null-hash entry with a recorded
// source but no live publish in memory. Caller writes the fixture (big when the hash must be
// observable, tiny when only the catalog state matters).
async function seedNullHashOrphan (ctx, name, abs) {
  const st = fs.statSync(abs)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, name, { size: st.size, mtime: st.mtimeMs, contentHash: null })
  await markOwnedSource(ctx.spaceId, '/' + name, abs)
  return abs
}

// The recovery keystone: the source link must be durable by the time the advertise
// refresh fires (the entry becomes visible), not only after the minutes-long hash —
// otherwise a quit mid-hash leaves a null-hash entry with no source, which neither
// boot rehydration nor the presence sweep can act on (a stuck "Adding" forever).
test('REGRESSION (FIX-D1: the owned-source link is durable by advertise time)', async (t) => {
  let sawAdvertise = null
  const advertised = new Promise((resolve) => { sawAdvertise = resolve })
  const ctx = await setup(t, (type) => { if (type === 'event:files-updated') sawAdvertise() })

  const abs = writeBig(ctx, 'big.bin')
  const publishing = looseShareFile(ctx.spaceId, abs)
  await advertised

  const srcAtAdvertise = await getOwnedSourcePath(ctx.spaceId, '/big.bin')
  const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'big.bin')
  t.is(srcAtAdvertise, abs, 'source link recorded before the hash completes')
  t.ok(entry, 'entry advertised')

  await publishing
  const final = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'big.bin')
  t.ok(final?.contentHash, 'publish completed with a real hash')
})

test('REGRESSION (FIX-D1: boot re-hashes an advertised entry whose source is recorded)', async (t) => {
  const ctx = await setup(t)
  const abs = path.join(ctx.tmpDir('src'), 'doc.pdf')
  fs.writeFileSync(abs, 'recoverable bytes')
  const st = fs.statSync(abs)

  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'doc.pdf', { size: st.size, mtime: st.mtimeMs, contentHash: null })
  await markOwnedSource(ctx.spaceId, '/doc.pdf', abs)

  await rehydrateLooseFiles()

  const entry = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'doc.pdf')
  t.ok(entry?.contentHash, 'null-hash entry re-hashed at boot via the recorded source')
})

test('REGRESSION (FIX-F1: boot reverts a null-hash orphan that has no recorded source)', async (t) => {
  const ctx = await setup(t)
  // No markOwnedSource → an orphan by construction: a build predating the advertise-time link,
  // or a crash inside the advertise-then-link window. Unresumable, so boot must revert it.
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'ghost.pdf', { size: 5, mtime: 1, contentHash: null })

  await rehydrateLooseFiles()

  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'ghost.pdf'),
    'orphaned half-publish tombstoned at boot — no more immortal "Adding"')
})

test('FIX-F1: boot LEAVES a finished entry that merely lost its source', async (t) => {
  const ctx = await setup(t)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'done.pdf', { size: 5, mtime: 1, contentHash: 'abc123' })

  await rehydrateLooseFiles()

  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'done.pdf'),
    'a completed entry with a lost source is not a zombie — keep it')
})

test('cancel mid-hash tombstones the entry and clears the early source link', async (t) => {
  let cancelled = false
  const ctx = await setup(t, (type) => {
    if (type === 'event:files-updated' && !cancelled) {
      cancelled = true
      looseCancelPublish(ctx.spaceId, '/big2.bin')
    }
  })

  const abs = writeBig(ctx, 'big2.bin')
  await looseShareFile(ctx.spaceId, abs)

  t.ok(cancelled, 'cancel issued during the hash')
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'big2.bin'), 'first publish reverted to tombstone')
  t.absent(await getOwnedSourcePath(ctx.spaceId, '/big2.bin'), 'early source link cleared with it')
})

test('a failed re-publish keeps the prior entry AND its source link', async (t) => {
  let bigSeen = false
  const ctx = await setup(t, (type, payload) => {
    if (type !== 'event:files-updated' || !bigSeen) return
    looseCancelPublish(ctx.spaceId, '/c.txt')
  })

  const abs = path.join(ctx.tmpDir('src'), 'c.txt')
  fs.writeFileSync(abs, 'version one')
  await looseShareFile(ctx.spaceId, abs)
  const first = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'c.txt')
  t.ok(first?.contentHash, 'initial publish landed')

  fs.writeFileSync(abs, Buffer.alloc(BIG, 0x62))
  bigSeen = true
  await looseShareFile(ctx.spaceId, abs)

  const after = await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'c.txt')
  t.ok(after?.contentHash, 'cancelled re-publish reverted to the prior version, not a tombstone')
  t.is(after?.contentHash, first.contentHash, 'prior hash restored')
  t.is(await getOwnedSourcePath(ctx.spaceId, '/c.txt'), abs, 'source link survives the failed re-publish')
})

// The advertise-time source link makes an in-flight publish VISIBLE to the presence sweep. A
// transient statSync failure on the source during the (lock-held) hash must NOT let two sweeps
// tombstone a file whose publish is still running — the active-publish guard protects it.
test('REGRESSION (FIX-22: the presence sweep never tombstones a file whose publish is in flight)', async (t) => {
  let advertised = null
  const seen = new Promise((resolve) => { advertised = resolve })
  const ctx = await setup(t, (type) => { if (type === 'event:files-updated') advertised() })

  const abs = writeBig(ctx, 'live.bin')
  const publishing = looseShareFile(ctx.spaceId, abs)
  await seen

  // Delete the source mid-hash — statSync will now throw in the sweep (exists=false). Run the
  // confirm-gone-twice sweep while the publish is still hashing.
  fs.rmSync(abs)
  await sweepLoosePresence()
  await sweepLoosePresence()

  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'live.bin'),
    'the in-flight publish survived both sweeps despite the vanished source')

  // The publish itself then resolves (its own vanish-detection reverts the null-hash entry).
  await publishing
})

test('REGRESSION (FIX-F2: cancel removes a restart-orphaned half-publish with no live task)', async (t) => {
  const ctx = await setup(t)
  // The cancel path never hashes the source (it only tombstones), so a tiny fixture suffices.
  const abs = path.join(ctx.tmpDir('src'), 'orphan.bin')
  fs.writeFileSync(abs, 'stranded')
  await seedNullHashOrphan(ctx, 'orphan.bin', abs)

  await looseCancelPublish(ctx.spaceId, '/orphan.bin')

  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'orphan.bin'), 'dead "Adding" row removed by cancel')
  t.absent(await getOwnedSourcePath(ctx.spaceId, '/orphan.bin'), 'source link cleared with it')
})

test('FIX-F2: cancel of a completed row is a no-op (null-hash guard)', async (t) => {
  const ctx = await setup(t)
  const abs = path.join(ctx.tmpDir('src'), 'k.txt')
  fs.writeFileSync(abs, 'done')
  await looseShareFile(ctx.spaceId, abs)
  t.ok((await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'k.txt'))?.contentHash, 'published')

  await looseCancelPublish(ctx.spaceId, '/k.txt')

  t.ok(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'k.txt'), 'a completed share is not unshared by a stale cancel')
})

test('REGRESSION (FIX-F4: boot resume of a null-hash entry emits a live progress bar)', async (t) => {
  const decos = []
  const ctx = await setup(t, (type, payload) => { if (type === 'event:decoration') decos.push(payload) })
  await seedNullHashOrphan(ctx, 'resume.bin', writeBig(ctx, 'resume.bin'))

  await rehydrateLooseFiles()

  t.ok(decos.some((d) => d.phase === 'publishing'), 'resume advertised a visible publishing bar, not a silent hash')
  t.ok((await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'resume.bin'))?.contentHash, 'resume completed')
})

test('FIX-F4: a healthy entry re-registers silently at boot (no phantom bar)', async (t) => {
  const decos = []
  const ctx = await setup(t, (type, payload) => { if (type === 'event:decoration') decos.push(payload) })
  const abs = path.join(ctx.tmpDir('src'), 'h.txt')
  fs.writeFileSync(abs, 'stable')
  await looseShareFile(ctx.spaceId, abs)
  decos.length = 0

  await rehydrateLooseFiles()

  t.absent(decos.find((d) => d.phase === 'publishing'), 'no "Adding" bar for an unchanged entry at boot')
})

test('FIX-F4: cancel aborts an in-flight boot resume', async (t) => {
  let resumeSeen = false
  const ctx = await setup(t, (type) => {
    if (type === 'event:files-updated' && !resumeSeen) {
      resumeSeen = true
      looseCancelPublish(ctx.spaceId, '/live-resume.bin')
    }
  })
  await seedNullHashOrphan(ctx, 'live-resume.bin', writeBig(ctx, 'live-resume.bin'))

  await rehydrateLooseFiles()

  t.ok(resumeSeen, 'resume advertised, so it was live and cancellable')
  t.absent(await getOwnEntry(ctx.spaceId, LOOSE_SHARE_ID, 'live-resume.bin'), 'cancel during the boot re-hash tombstoned it')
})
