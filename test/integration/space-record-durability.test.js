import test from 'brittle'
import { freshPeerWithIdentity } from '../helpers/store.js'
import { initOverlay, teardownOverlay } from '../../src/shared/transfer/backends/overlay/overlay-instance.js'
import { initDownloads } from '../../src/shared/transfer/files.js'
import {
  createSpace, getSpace, getDrive, loadDrives, listSpaces,
  persistLeftTombstone, loadLeftTombstones, clearLeftTombstone,
  persistPendingLeave, listPendingLeaves, clearPendingLeave, _spacesBeeForTests,
} from '../../src/shared/spaces/space.js'

// The space record is the user's only handle on a space. A transient fault opening its drive
// must cost a retry, never the record; and the leave-marker cleanups self-heal but must say so.

const K = 'a'.repeat(64)

// Bare reports a deadlock when only unref'd handles remain; the worker's IPC pipe plays this
// role in production, so a bare test has to hold the loop open itself.
function keepLoopAlive (t) {
  const keep = setInterval(() => {}, 500)
  t.teardown(() => clearInterval(keep))
}

// loadDrives' post-load backfill publishes the loose-catalog key, which needs the overlay —
// without it a SUCCESSFUL load parks instead of returning.
async function setup (t) {
  keepLoopAlive(t)
  const ctx = await freshPeerWithIdentity(t)
  await initDownloads()
  await initOverlay()
  t.teardown(async () => { await teardownOverlay() })
  return ctx
}

function captureLog (t, method, prefix) {
  const lines = []
  const real = console[method]
  console[method] = (...a) => { const s = a.join(' '); if (s.startsWith(prefix)) lines.push(s); else real(...a) }
  t.teardown(() => { console[method] = real })
  return lines
}

function failSpacesDel (t, pred) {
  const bee = _spacesBeeForTests()
  const realDel = bee.del.bind(bee)
  bee.del = (key, opts) => pred(key) ? Promise.reject(new Error('EIO: injected del failure')) : realDel(key, opts)
  t.teardown(() => { bee.del = realDel })
}

// REGRESSION (FIX-PENDING-SWALLOW-7: any failure inside loadDrives' try deleted the space
// record — including a transient open failure, and including failures from the two backfill
// writes that share the block. A lock still held by a dying instance cost the user the space.)
test('REGRESSION (FIX-PENDING-SWALLOW-7): a transient drive-load failure keeps the space and marks it for retry', async (t) => {
  await setup(t)
  const space = await createSpace('Durable Space')
  const errors = captureLog(t, 'error', '[space]')

  const res = await loadDrives({ openDrive: async () => { throw new Error('ELOCKED: held by another instance') } })

  t.ok(res.hadFailure, 'the failure is reported to the caller')
  const kept = await getSpace(space.spaceId)
  t.ok(kept, 'the space record SURVIVES a transient open failure')
  t.ok(kept.driveLoadError, 'and carries a durable marker naming the failure')
  t.ok(errors.some((l) => l.includes('keeping the space record for retry')), 'the log says the record was kept')

  // The next boot retries and, on success, clears the marker. The opener hands back the drive
  // createSpace already opened: a second Hyperdrive instance on the same core would contend for
  // its write lock, which is a harness artefact, not the behavior under test.
  const open = getDrive(space.spaceId)
  await loadDrives({ openDrive: async () => open })
  t.ok(getDrive(space.spaceId), 'the retry registered the drive')
  t.absent((await getSpace(space.spaceId)).driveLoadError, 'and cleared the marker')
})

// A positively identified storage inconsistency is the one case that cannot be retried, so it
// keeps the original behavior: drop the record and let the leftover sweep reclaim the cores.
test('a storage-inconsistent drive still drops its record', async (t) => {
  await setup(t)
  const space = await createSpace('Broken Space')
  const errors = captureLog(t, 'error', '[space]')

  const res = await loadDrives({
    // The exact shape isStorageInconsistency classifies: the bitfield claims blocks the
    // tree-node store cannot back.
    openDrive: async () => { throw new Error('Expected tree node 42 from storage, got (nil)') },
  })

  t.ok(res.hadFailure, 'still reported as a failure')
  t.absent(await getSpace(space.spaceId), 'the unopenable record is dropped')
  t.ok(errors.some((l) => l.includes('dropping space record')), 'and the log says why')
})

// A backfill failure is not a drive failure: it must not cost the record either. Before this
// change the backfills shared the open's try block, so a profile-bee write failing deleted the
// space outright.
test('a post-load backfill failure keeps the drive and the record', async (t) => {
  await setup(t)
  const space = await createSpace('Backfill Space')
  const before = (await listSpaces()).length
  const open = getDrive(space.spaceId)
  const warns = captureLog(t, 'warn', '[space]')
  // markSpaceDriveKey / publishLooseCatalogKey both write the profile bee; fail every write.
  const { getProfileBee } = await import('../../src/shared/spaces/profile.js')
  const bee = getProfileBee()
  const realPut = bee.put.bind(bee)
  bee.put = () => Promise.reject(new Error('EIO: injected backfill failure'))
  t.teardown(() => { bee.put = realPut })

  await loadDrives({ openDrive: async () => open })

  t.ok(getDrive(space.spaceId), 'the drive is still registered')
  t.is((await listSpaces()).length, before, 'and the record is intact')
  // publishLooseCatalogKey swallows its own write failures by design, so the observable
  // guarantee here is that the drive and the record survive it — not a specific log line.
})

// REGRESSION (FIX-PENDING-SWALLOW-6: the three leave-marker dels swallowed every failure. Each
// self-heals — a surviving tombstone re-seeds the fold until a newer member ts, a surviving
// pending-leave marker is re-cleared at boot — but a member who reappears as "left" after a
// restart could not be explained from the log.)
test('REGRESSION (FIX-PENDING-SWALLOW-6): a failed leave-marker cleanup is visible and never throws', async (t) => {
  await setup(t)
  const S = 'spaceswal0000000'
  await persistLeftTombstone(S, K, 100)
  await persistPendingLeave(S, 'ab'.repeat(32), 1)
  const warns = captureLog(t, 'warn', '[space]')
  failSpacesDel(t, () => true)

  // Both are non-throwing by contract — callers ignore the result.
  await clearLeftTombstone(S, K)
  await clearPendingLeave(S)

  t.is((await loadLeftTombstones(S)).size, 1, 'the tombstone survives the failed del (it self-heals at the next boot)')
  t.is((await listPendingLeaves()).filter((p) => p.spaceId === S).length, 1, 'so does the pending-leave marker')
  t.ok(warns.some((l) => l.includes('could not clear a leave tombstone')), 'the failed tombstone del is said out loud')
  t.ok(warns.some((l) => l.includes('could not clear the pending-leave marker')), 'and so is the failed marker del')
})
