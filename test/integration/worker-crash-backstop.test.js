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
    /\binstallCrashBackstop\s*\(\s*log\s*\)/.test(workerMainSrc),
    'worker/main.js calls installCrashBackstop(log) — without it an unhandled rejection aborts the worker'
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
  const backstopAt = workerMainSrc.indexOf('installCrashBackstop(log)')
  const firstAwaitAt = workerMainSrc.indexOf('await getBootstrapPromise()')
  const bootAt = workerMainSrc.indexOf('await boot(bootstrap')
  t.ok(backstopAt > 0 && firstAwaitAt > 0 && bootAt > 0, 'all boot markers present')
  t.ok(backstopAt < firstAwaitAt, 'backstop is installed before the entry\'s first await')
  t.ok(backstopAt < bootAt, 'backstop is installed before boot() — i.e. before every core open')
  const bootSrc = fs.readFileSync(path.join(srcRoot, 'worker', 'boot.js'), 'utf8')
  for (const marker of ['initStore(', 'initBackends(', 'initSwarm(']) {
    t.ok(bootSrc.includes(marker), marker + ' opens cores inside the root, after the backstop')
  }
})

test('REGRESSION (FIX-1 wiring): the fire-and-forget handshake dispatch is .catch-guarded', (t) => {
  t.ok(
    /handleHandshake\([^)]*\)\s*\.catch\s*\(/.test(swarmSrc),
    'dispatchFrame guards the async handleHandshake call with .catch — an un-awaited rejection would otherwise escape the synchronous try/catch around dispatchFrame'
  )
})
