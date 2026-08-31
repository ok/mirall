import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { installCrashBackstop } from '../../src/shared/core/crash-backstop.js'

const srcRoot = path.join(path.dirname(import.meta.url.replace(/^file:\/\//, '')), '..', '..', 'src')
const workerMainSrc = fs.readFileSync(path.join(srcRoot, 'worker', 'main.js'), 'utf8')
const swarmSrc = fs.readFileSync(path.join(srcRoot, 'shared', 'transfer', 'swarm.js'), 'utf8')

// REGRESSION (FIX: worker survives an unhandled rejection from a fire-and-forget task).
// A STORAGE_EMPTY thrown by corestore's replication machinery when it serves a half-written
// ("zombie") core by discovery key reaches the worker as an UNHANDLED rejection. Before the
// backstop the Bare worker had no global handler, so that rejection aborted the process and the
// whole data layer died ("app fails to start"). Reaching the assertions below at all proves the
// process was NOT aborted — without installCrashBackstop the scheduled rejection kills the worklet.
test('REGRESSION (FIX: unhandled rejection does not abort the worker)', async (t) => {
  const logged = []
  const dispose = installCrashBackstop({ error: (...a) => logged.push(a.join(' ')) })
  t.teardown(dispose)

  await new Promise((resolve) => {
    Promise.reject(Object.assign(new Error('synthetic-storage-empty'), { code: 'STORAGE_EMPTY' }))
    setTimeout(resolve, 50)
  })

  t.ok(true, 'worker process survived the unhandled rejection')
  t.ok(logged.some((l) => l.includes('unhandledRejection') && l.includes('synthetic-storage-empty')), 'the rejection was logged by the backstop')
})

// REGRESSION (FIX: a thrown exception in a fire-and-forget timer/callback also does not abort).
test('REGRESSION (FIX: uncaught exception does not abort the worker)', async (t) => {
  const logged = []
  const dispose = installCrashBackstop({ error: (...a) => logged.push(a.join(' ')) })
  t.teardown(dispose)

  await new Promise((resolve) => {
    setTimeout(() => { throw Object.assign(new Error('synthetic-uncaught'), { code: 'STORAGE_EMPTY' }) }, 10)
    setTimeout(resolve, 60)
  })

  t.ok(true, 'worker process survived the uncaught exception')
  t.ok(logged.some((l) => l.includes('uncaughtException') && l.includes('synthetic-uncaught')), 'the exception was logged by the backstop')
})

// Wiring guards. The behavioral guarantee (the backstop suppresses Bare's abort) is proven
// above, and the whole flow suite boots the real worker; these assert the fix is actually
// wired in so it can't be silently removed (deleting either line would otherwise leave every
// test green). Source-text checks, like test/unit/bundle-axe-stripped.test.js.
test('REGRESSION (FIX-3 wiring): the worker installs the crash backstop at boot', (t) => {
  t.ok(
    /import\s*\{[^}]*\binstallCrashBackstop\b[^}]*\}\s*from\s*['"][^'"]*crash-backstop\.js['"]/.test(workerMainSrc),
    'worker/main.js imports installCrashBackstop from crash-backstop.js'
  )
  t.ok(
    /\binstallCrashBackstop\s*\(\s*log\b/.test(workerMainSrc),
    'worker/main.js calls installCrashBackstop(log, …) — without it an unhandled rejection aborts the worker'
  )
  t.ok(
    /isArmed:\s*\(\)\s*=>\s*bootComplete\s*&&\s*!shuttingDown/.test(workerMainSrc),
    'escalation is armed only once boot finished and no shutdown is running'
  )
  t.ok(
    /onUnstable:.*safeShutdown\('unstable',\s*WORKER_EXIT_UNSTABLE\)/.test(workerMainSrc),
    'escalation goes through safeShutdown (bounded by its deadline) and carries the unstable exit code'
  )
})

// REGRESSION (FIX: the backstop must be installed BEFORE any core-opening boot init).
// A fire-and-forget STORAGE_EMPTY rejection from a background core open during the data-layer
// init (initStore…loadDrives…initBackends) was escaping because the backstop was installed
// only further down (just before initSwarm) — Bare's default handler then aborted the worker
// at boot ("the app won't start"). Installing it up front catches that rejection so boot
// continues. Was RED before the fix (call site sat after initStore); ordering is asserted so
// it can't silently drift back down. With the boot sequence in the composition root the
// invariant is literal: the backstop precedes the entry's FIRST await (the bootstrap frame), and
// therefore boot(), which is where every core open now lives.
test('REGRESSION (FIX: crash backstop is installed before the core-opening boot init)', (t) => {
  const backstopAt = workerMainSrc.indexOf('installCrashBackstop(log,')
  const firstAwaitAt = workerMainSrc.indexOf('await getBootstrapPromise()')
  const bootAt = workerMainSrc.indexOf('await boot(bootstrap')
  t.ok(backstopAt > 0 && firstAwaitAt > 0 && bootAt > 0, 'all boot markers present')
  t.ok(backstopAt < firstAwaitAt, 'backstop is installed before the entry\'s first await')
  t.ok(backstopAt < bootAt, 'backstop is installed before boot() — i.e. before every core open')
  const bootSrc = fs.readFileSync(path.join(srcRoot, 'worker', 'boot.js'), 'utf8')
  for (const marker of ['new Store(', 'new OverlayBackend(', 'new Swarm(']) {
    t.ok(bootSrc.includes(marker), marker + ' opens cores inside the root, after the backstop')
  }
})

test('REGRESSION (FIX-1 wiring): the fire-and-forget handshake dispatch is .catch-guarded', (t) => {
  t.ok(
    /handleHandshake\([^)]*\)\s*\.catch\s*\(/.test(swarmSrc),
    'dispatchFrame guards the async handleHandshake call with .catch — an un-awaited rejection would otherwise escape the synchronous try/catch around dispatchFrame'
  )
})

// The escalation half. installCrashBackstop keeps a worker alive through ISOLATED faults — that is
// what the two tests at the top of this file prove and it must not change. What is added is a RATE:
// a worker producing faults faster than the threshold is not recovering, and staying up leaves it
// wedged silently forever with nothing reporting it.
//
// A fake clock rather than real time: the window is 60s in production and a test must not be.
function fakeClock() {
  let t = 1_000_000
  return { now: () => t, advance: (ms) => { t += ms } }
}

const silentLog = { error() {}, warn() {}, info() {}, debug() {} }

// Bare's own emit is the only way to drive the installed listeners, and a synthetic throw would
// abort the test worklet. Calling the handler through Bare's emitter exercises the real wiring.
function stormOf(n, emit) { for (let i = 0; i < n; i++) emit() }

test('an isolated fault still keeps the worker alive and never escalates', (t) => {
  const calls = []
  const clock = fakeClock()
  const dispose = installCrashBackstop(silentLog, {
    threshold: 3, windowMs: 1000, now: clock.now, onUnstable: () => calls.push(1),
  })
  t.teardown(dispose)
  Bare.emit('unhandledRejection', new Error('isolated'))
  t.is(calls.length, 0, 'one fault below the threshold does not exit — the original guarantee')
})

test('REGRESSION (FIX-R09-1: a fault storm left the worker wedged instead of respawning)', (t) => {
  const calls = []
  const clock = fakeClock()
  const dispose = installCrashBackstop(silentLog, {
    threshold: 3, windowMs: 1000, now: clock.now, onUnstable: () => calls.push(1),
  })
  t.teardown(dispose)
  stormOf(3, () => Bare.emit('unhandledRejection', new Error('storm')))
  t.is(calls.length, 1, 'escalates once the threshold is reached inside the window')
})

// The test that justifies a RATE over a total: without the window, a healthy long-running session
// accumulating isolated faults over hours would eventually exit for no reason.
test('faults spread wider than the window never escalate', (t) => {
  const calls = []
  const clock = fakeClock()
  const dispose = installCrashBackstop(silentLog, {
    threshold: 3, windowMs: 1000, now: clock.now, onUnstable: () => calls.push(1),
  })
  t.teardown(dispose)
  for (let i = 0; i < 10; i++) {
    Bare.emit('unhandledRejection', new Error('slow drip'))
    clock.advance(10 * 60 * 1000)
  }
  t.is(calls.length, 0, 'ten faults ten minutes apart are a healthy worker, not an unstable one')
})

test('escalation fires exactly once under a sustained storm', (t) => {
  const calls = []
  const clock = fakeClock()
  const dispose = installCrashBackstop(silentLog, {
    threshold: 3, windowMs: 1000, now: clock.now, onUnstable: () => calls.push(1),
  })
  t.teardown(dispose)
  stormOf(50, () => Bare.emit('uncaughtException', new Error('storm')))
  t.is(calls.length, 1, 'the latch holds — 50 faults produce one exit, not 48 racing ones')
})

// REGRESSION: the backstop is installed BEFORE boot precisely so a storm of background core opens
// during startup cannot abort the worker. Escalating there would turn "slow to start" into "will
// not start" — and a worker that dies before ready is what the renderer's give-up budget stops by
// leaving the app permanently dead.
test('REGRESSION (FIX-R09-1: a boot-time storm must not escalate while disarmed)', (t) => {
  const calls = []
  const clock = fakeClock()
  let armed = false
  const dispose = installCrashBackstop(silentLog, {
    threshold: 3, windowMs: 60_000, now: clock.now, isArmed: () => armed, onUnstable: () => calls.push(1),
  })
  t.teardown(dispose)
  stormOf(10, () => Bare.emit('unhandledRejection', new Error('boot storm')))
  t.is(calls.length, 0, 'a storm during boot is logged and survived, exactly as before')

  // Disarming must not SPEND the one escalation: a storm continuing past boot still has to exit.
  armed = true
  Bare.emit('unhandledRejection', new Error('still failing after boot'))
  t.is(calls.length, 1, 'the latch was not burned while disarmed — the next fault escalates')
})

test('the fault window stays bounded under a sustained storm', (t) => {
  const clock = fakeClock()
  const dispose = installCrashBackstop(silentLog, {
    threshold: 1e9, windowMs: 1000, now: clock.now, onUnstable: () => {},
  })
  t.teardown(dispose)
  // Without the filter-on-every-record this is itself an unbounded-memory bug: the array would
  // hold every fault for the life of the worker.
  for (let i = 0; i < 5000; i++) {
    Bare.emit('unhandledRejection', new Error('storm'))
    clock.advance(10) // 5000 faults spanning 50s, of which only the last 1000ms may be retained
  }
  // 1000ms of window at one fault per 10ms is ~101 stamps. Asserting the COUNT, not merely that
  // the process survived: an unpruned array reaches 5000 here and survives just as happily.
  t.ok(dispose.faultsInWindow() <= 101, `the window holds one window's worth, not all 5000 (held ${dispose.faultsInWindow()})`)
})
