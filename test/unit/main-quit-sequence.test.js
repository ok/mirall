import test from 'brittle'
import { QUIT_STEPS, createQuitSequence } from '../../src/main/lifecycle.js'

// Electron's contract: app.quit() emits before-quit to every listener; a listener may
// preventDefault() to abort that quit, and a later app.quit() re-emits to all of them.
function fakeApp(handler) {
  const app = { quits: 0, deferred: 0, exited: 0 }
  app.quit = () => {
    app.quits += 1
    let prevented = false
    handler({ preventDefault() { prevented = true } })
    if (prevented) app.deferred += 1
    else app.exited += 1
  }
  return app
}

function recorder(overrides = {}) {
  const calls = []
  const step = (name) => () => {
    calls.push(name)
    if (overrides[name]) return overrides[name]()
  }
  return {
    calls,
    steps: {
      markQuitting: step('mark-quitting'),
      stopOwnedWatchers: step('stop-owned-watchers'),
      stopLooseWatchers: step('stop-loose-watchers'),
      flushConfig: step('flush-config'),
      stopWorkers: step('stop-workers'),
      applyUpdate: step('apply-update'),
    },
  }
}

test('QUIT_STEPS is the declared teardown order', (t) => {
  t.alike([...QUIT_STEPS], [
    'mark-quitting',
    'stop-owned-watchers',
    'stop-loose-watchers',
    'flush-config',
    'stop-workers',
    'apply-update',
  ], 'watchers stop before the config flush; the worker stops before the update is applied')
  t.ok(Object.isFrozen(QUIT_STEPS))
})

test('a plain quit runs every step once, in order, and does not defer', (t) => {
  const rec = recorder()
  const app = fakeApp(createQuitSequence({ ...rec.steps, quit: () => app.quit() }))
  app.quit()
  t.alike(rec.calls, [...QUIT_STEPS], 'every step ran exactly once, in QUIT_STEPS order')
  t.is(app.deferred, 0)
  t.is(app.exited, 1)
})

test('REGRESSION (FIX-220): an update-apply quit runs each teardown exactly once', async (t) => {
  let applyDone = false
  const rec = recorder({
    'apply-update': async () => { await Promise.resolve(); applyDone = true },
  })
  let prevents = 0
  const handler = createQuitSequence({ ...rec.steps, quit: () => app.quit() })
  const app = fakeApp((event) => handler({ preventDefault() { prevents += 1; event.preventDefault() } }))

  app.quit()
  // The deferred quit lands when the apply settles.
  await new Promise((resolve) => setTimeout(resolve, 20))

  for (const step of QUIT_STEPS) {
    t.is(rec.calls.filter((c) => c === step).length, 1, `${step} ran exactly once`)
  }
  t.alike(rec.calls, [...QUIT_STEPS], 'and in order — the re-issued quit adds nothing')
  t.is(prevents, 1, 'the quit was deferred exactly once')
  t.is(app.quits, 2, 'the deferral re-issued the quit')
  t.is(app.exited, 1, 'the re-issued quit was not deferred again')
  t.ok(applyDone, 'the update was applied before the process was allowed to exit')
})

test('the worker is asked to exit before the update apply starts', (t) => {
  const order = []
  const handler = createQuitSequence({
    markQuitting: () => {},
    stopOwnedWatchers: () => {},
    stopLooseWatchers: () => {},
    flushConfig: () => order.push('flush-config'),
    stopWorkers: () => order.push('stop-workers'),
    applyUpdate: () => { order.push('apply-update'); return Promise.resolve() },
    quit: () => {},
  })
  handler({ preventDefault() {} })
  t.alike(order, ['flush-config', 'stop-workers', 'apply-update'])
})

test('a step that throws is reported and does not skip the steps after it', (t) => {
  const errors = []
  const rec = recorder({
    'stop-owned-watchers': () => { throw new Error('watcher boom') },
    'flush-config': () => { throw new Error('flush boom') },
  })
  const handler = createQuitSequence({
    ...rec.steps,
    quit: () => {},
    onStepError: (step, err) => errors.push([step, err.message]),
  })
  handler({ preventDefault() {} })
  t.alike(rec.calls, [...QUIT_STEPS], 'every later step still ran')
  t.alike(errors, [['stop-owned-watchers', 'watcher boom'], ['flush-config', 'flush boom']])
})

test('a synchronous throw from applyUpdate is reported and the quit is not deferred', (t) => {
  const errors = []
  let prevented = false
  const rec = recorder({ 'apply-update': () => { throw new Error('apply boom') } })
  const handler = createQuitSequence({
    ...rec.steps,
    quit: () => {},
    onStepError: (step, err) => errors.push([step, err.message]),
  })
  handler({ preventDefault() { prevented = true } })
  t.absent(prevented, 'a quit that cannot apply an update still exits')
  t.alike(errors, [['apply-update', 'apply boom']])
})

test('a rejected apply still lets the quit through', async (t) => {
  const errors = []
  const rec = recorder({ 'apply-update': () => Promise.reject(new Error('swap failed')) })
  const handler = createQuitSequence({
    ...rec.steps,
    quit: () => app.quit(),
    onStepError: (step, err) => errors.push([step, err.message]),
  })
  const app = fakeApp(handler)
  app.quit()
  await new Promise((resolve) => setTimeout(resolve, 20))
  t.is(app.exited, 1, 'the process exits rather than hanging on a failed swap')
  t.alike(errors, [['apply-update', 'swap failed']])
})

test('a quit issued after the sequence has run is a no-op', (t) => {
  const rec = recorder()
  const handler = createQuitSequence({ ...rec.steps, quit: () => {} })
  handler({ preventDefault() {} })
  handler({ preventDefault() {} })
  handler({ preventDefault() {} })
  t.alike(rec.calls, [...QUIT_STEPS], 'the teardown is run at most once per process')
})
