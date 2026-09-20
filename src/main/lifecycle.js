// The main process's quit teardown: one ordered sequence behind a single
// `before-quit` listener. Electron emits `before-quit` to every listener on every
// `app.quit()`, so a listener that defers the quit (preventDefault → async work →
// quit again) makes each of its siblings run once per pass. Sequencing the steps
// here — and running them at most once per process — is what keeps a deferred
// update-apply quit from tearing the app down twice.

// The teardown order a quit runs, and the only order it runs in.
//
// - `mark-quitting` first: the window close handler hides to tray unless the flag
//   is set, and the worker frame writer only stays quiet about a failed write once
//   it is — so every later step has to run behind it.
// - both watchers before `flush-config`: a live watcher can dirty the config
//   store, and a write landing after the flush is lost.
// - `stop-workers` before `apply-update`: the update swaps the files this process
//   runs from, so the worker is asked to exit before the swap starts rather than
//   racing it.
// - `apply-update` last, and the only step that may defer the quit.
const QUIT_STEPS = Object.freeze([
  'mark-quitting',
  'stop-owned-watchers',
  'stop-loose-watchers',
  'flush-config',
  'stop-workers',
  'apply-update',
])

/**
 * Builds the ordered `before-quit` handler.
 *
 * Each step is independent, so a step that throws is recorded and the sequence
 * continues: aborting would skip `stop-workers` and leave an orphaned worker
 * subprocess holding the store, which is a worse outcome than the error that
 * preceded it.
 *
 * `applyUpdate` returns a promise when a staged update is being applied and a
 * falsy value when there is nothing to apply. A promise defers the quit
 * (`event.preventDefault()`) and re-issues it once the apply settles; the
 * re-issued quit re-enters this handler, which has already run and does nothing.
 *
 * @param {object} steps
 * @param {() => void} steps.markQuitting
 * @param {() => void} steps.stopOwnedWatchers
 * @param {() => void} steps.stopLooseWatchers
 * @param {() => void} steps.flushConfig
 * @param {() => void} steps.stopWorkers
 * @param {() => Promise<void> | null | undefined} steps.applyUpdate
 * @param {() => void} steps.quit — re-issues the deferred quit.
 * @param {(step: string, err: Error) => void} [steps.onStepError]
 */
function createQuitSequence({ markQuitting, stopOwnedWatchers, stopLooseWatchers, flushConfig, stopWorkers, applyUpdate, quit, onStepError }) {
  const runners = {
    'mark-quitting': markQuitting,
    'stop-owned-watchers': stopOwnedWatchers,
    'stop-loose-watchers': stopLooseWatchers,
    'flush-config': flushConfig,
    'stop-workers': stopWorkers,
  }
  let ran = false

  function report(step, err) {
    if (onStepError) onStepError(step, err)
  }

  return function onBeforeQuit(event) {
    if (ran) return
    ran = true
    for (const step of QUIT_STEPS) {
      if (step === 'apply-update') continue
      try { runners[step]() } catch (err) { report(step, err) }
    }
    let pending = null
    try { pending = applyUpdate() } catch (err) { report('apply-update', err) }
    if (!pending) return
    event.preventDefault()
    pending
      .catch((err) => report('apply-update', err))
      .finally(() => quit())
  }
}

// Replacing a running worker, in the only order that works:
// - `stop-worker` first and AWAITED. Two workers on one Corestore is a lock error at best, and the
//   new one reads its whole starting state at spawn, so it must not start before the old one ends.
// - `spawn-worker` builds a fresh bootstrap frame, which is the point of a restart: the relay
//   identity and every other spawn-time value are read there and nowhere else.
const RESTART_STEPS = Object.freeze(['stop-worker', 'spawn-worker'])

/**
 * @param {object} steps
 * @param {(specifier: string) => Promise<unknown>} steps.stopWorker
 * @param {(specifier: string) => void} steps.spawnWorker
 * @param {() => boolean} steps.isQuitting
 */
function createWorkerRestart({ stopWorker, spawnWorker, isQuitting }) {
  // A second request joins the first rather than racing it: two restarts in flight would stop the
  // worker the other just spawned.
  const inFlight = new Map()
  return function restartWorker(specifier) {
    if (isQuitting()) return Promise.resolve(false)
    const running = inFlight.get(specifier)
    if (running) return running
    const run = (async () => {
      await stopWorker(specifier)
      // Re-checked: the quit sequence may have begun while the old worker was shutting down, and
      // spawning into a quit leaves exactly the orphan stop-workers exists to prevent.
      if (isQuitting()) return false
      spawnWorker(specifier)
      return true
    })().finally(() => inFlight.delete(specifier))
    inFlight.set(specifier, run)
    return run
  }
}

// test seam: QUIT_STEPS and RESTART_STEPS are exported for tests only.
module.exports = { QUIT_STEPS, createQuitSequence, RESTART_STEPS, createWorkerRestart }
