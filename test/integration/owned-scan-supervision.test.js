import test from 'brittle'
import { wedgedScan, waitUntil, delay } from '../helpers/wedged-scan.js'

// The owner side declares supervisable units. Until it did, a reconcile pass that never settled
// held its share's key forever: no crash, no log line, health() said ok, and the only cure was a
// restart. The mechanism itself is covered in subsystem-supervision.test.js; what is covered here
// is the adoption — the rows OwnedFolders reports, and what recover() actually does to the pass.

test('a wedged owner scan is reported as a supervisable unit labelled with its share', async (t) => {
  const w = await wedgedScan(t)
  w.startScan()
  await waitUntil(() => w.scans.started === 1)

  t.alike(w.owned.supervise().map((row) => row.ok), [true], 'a pass that just started is not wedged')

  await waitUntil(() => w.owned.supervise()[0]?.ok === false)
  const [row] = w.owned.supervise()
  t.is(row.key, w.passKey, 'the unit is one reconcile pass, keyed by space and share')
  t.is(row.label, w.passKey, 'and the log-safe label names it')
  t.ok(row.detail.startsWith('no progress for'), 'with how long it has been quiet')
})

test('the redacted health report counts the wedge and names nothing', async (t) => {
  const w = await wedgedScan(t)
  w.startScan()
  await waitUntil(() => w.owned.supervise()[0]?.ok === false)

  const health = w.owned.health()
  t.is(health.ok, false)
  t.is(health.scans.wedged, 1)
  const serialised = JSON.stringify(health)
  t.absent(serialised.includes(w.spaceId), 'no space id reaches the shareable bundle')
  t.absent(serialised.includes(w.shareId), 'and no share id either')
})

// REGRESSION (FIX-OWNER-SCAN-WEDGE: a reconcile pass that never settled held its share's key for
// the life of the process. The coalescing runner handed every later caller the same never-settling
// promise, so that share's reconcile never ran again.)
test('REGRESSION (FIX-OWNER-SCAN-WEDGE): a wedged scan is abandoned and a fresh one re-armed', async (t) => {
  const w = await wedgedScan(t)
  w.startScan()
  await waitUntil(() => w.owned.supervise()[0]?.ok === false)

  await w.supervisor.probe()
  t.alike(w.owned.supervise().map((row) => row.ok), [false], 'one bad probe is not enough to act')
  await w.supervisor.probe()

  // The recovery re-arms the scan itself. Leaving it to the cadence would mean up to six hours
  // (RECONCILE_INTERVAL_MS) with nothing scanning the folder — the watcher only fires on a
  // filesystem event, so an idle share would simply stop syncing.
  await waitUntil(() => w.scans.started === 2, 3000)
  t.is(w.supervisor.stats().recoveries['owned-folders'], 1, 'and the recovery is counted by subsystem')
  t.ok(w.owned.supervise().some((row) => row.key === w.passKey), 'the share is still a reported unit')
})

// REGRESSION (FIX-OWNER-SCAN-ZOMBIE: the abandoned pass keeps running. When it finally unparked it
// cleared the heartbeat of the pass that had taken its key, and its coalescing entry started that
// entry's queued rerun — two passes over one mount, and a live pass invisible to the supervisor.)
test('REGRESSION (FIX-OWNER-SCAN-ZOMBIE): an abandoned pass that unparks late touches nothing', async (t) => {
  const w = await wedgedScan(t)
  w.startScan()
  await waitUntil(() => w.owned.supervise()[0]?.ok === false)
  await w.supervisor.probe()
  await w.supervisor.probe()
  await waitUntil(() => w.scans.started === 2, 3000)

  w.release()                       // the zombie's walk returns, long after it was abandoned
  await delay(100)
  t.is(w.scans.started, 2, 'the late settle started no pass of its own')
  t.is(w.owned.supervise().length, 1, 'and did not end the pass that replaced it')
})

// REGRESSION (FIX-ABANDONED-ROW: recover() dropped the share from the reported units the instant it
// acted. The policy prunes the counters of any unit nobody reports, so the recovery budget reset on
// every attempt: maxRecoveries was unreachable, the app retried a dead mount forever, and the one
// error line that names the folder it gave up on could never print. This is the whole point of the
// row, so it is asserted end to end.)
test('REGRESSION (FIX-ABANDONED-ROW): a mount that wedges every pass is given up on by name', async (t) => {
  const w = await wedgedScan(t)
  const errors = []
  w.supervisor.log = { debug() {}, info() {}, warn() {}, error: (...a) => errors.push(a.join(' ')) }
  w.startScan()

  // Every recovery re-arms a pass that wedges in the same place, so the budget is spent down one
  // strike at a time. It converges only because the row survives each recovery.
  for (let i = 0; i < 14; i++) {
    if (w.supervisor.stats().gaveUp['owned-folders']) break
    await waitUntil(() => w.owned.supervise().some((row) => row.ok === false), 3000)
    await w.supervisor.probe()
  }

  t.is(w.supervisor.stats().recoveries['owned-folders'], 3, 'exactly maxRecoveries attempts, not an endless retry')
  t.is(w.supervisor.stats().gaveUp['owned-folders'], 1, 'and then it stops')
  t.ok(errors.some((line) => line.includes(w.passKey)), 'the give-up line names the folder')
})
