import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { _spacesBeeForTests } from '../../src/shared/spaces/space.js'
import { persistLeftTombstone, loadLeftTombstones, clearLeftTombstone, persistPendingLeave, listPendingLeaves, clearPendingLeave } from '../../src/shared/spaces/leave-records.js'

// The space record is the user's only handle on a space; the leave-marker cleanups self-heal but
// must say so.

const K = 'a'.repeat(64)

// Bare reports a deadlock when only unref'd handles remain; the worker's IPC pipe plays this
// role in production, so a bare test has to hold the loop open itself.
function keepLoopAlive(t) {
  const keep = setInterval(() => {}, 500)
  t.teardown(() => clearInterval(keep))
}

async function setup(t) {
  keepLoopAlive(t)
  return await freshPeer(t)
}

function captureLog(t, method, prefix) {
  const lines = []
  const real = console[method]
  console[method] = (...a) => { const s = a.join(' '); if (s.startsWith(prefix)) lines.push(s); else real(...a) }
  t.teardown(() => { console[method] = real })
  return lines
}

function failSpacesDel(t, pred) {
  const bee = _spacesBeeForTests()
  const realDel = bee.del.bind(bee)
  bee.del = (key, opts) => pred(key) ? Promise.reject(new Error('EIO: injected del failure')) : realDel(key, opts)
  t.teardown(() => { bee.del = realDel })
}

// REGRESSION (FIX-PENDING-SWALLOW-6: the three leave-marker dels swallowed every failure. Each
// self-heals — a surviving tombstone re-seeds the fold until a newer member ts, a surviving
// pending-leave marker is re-cleared at boot — but a member who reappears as "left" after a
// restart could not be explained from the log.)
test('REGRESSION (FIX-PENDING-SWALLOW-6): a failed leave-marker cleanup is visible and never throws', async (t) => {
  await setup(t)
  const S = 'spaceswal0000000'
  await persistLeftTombstone(S, K, 100)
  await persistPendingLeave(S, 'ab'.repeat(32), 1)
  const warns = captureLog(t, 'warn', '[leave-records]')
  failSpacesDel(t, () => true)

  // Both are non-throwing by contract — callers ignore the result.
  await clearLeftTombstone(S, K)
  await clearPendingLeave(S)

  t.is((await loadLeftTombstones(S)).size, 1, 'the tombstone survives the failed del (it self-heals at the next boot)')
  t.is((await listPendingLeaves()).filter((p) => p.spaceId === S).length, 1, 'so does the pending-leave marker')
  t.ok(warns.some((l) => l.includes('could not clear a leave tombstone')), 'the failed tombstone del is said out loud')
  t.ok(warns.some((l) => l.includes('could not clear the pending-leave marker')), 'and so is the failed marker del')
})
