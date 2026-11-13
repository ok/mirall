// A synchronous stand-in for the file watcher package (chokidar4bare), shared by every test that
// drives the back end's watchers (src/worker/watchers/).
// Real fsevents timing plus awaitWriteFinish makes an fs-watch test slow and flaky, so each fake
// watcher is an EventEmitter the test emits on directly. It lives here rather than in each test
// file for the same reason watch-host.js exists: one model of the watcher surface, so the tests
// cannot drift from each other about what that surface is.
import { EventEmitter } from 'bare-events'

/**
 * A watch environment whose engine records every watcher it builds.
 *
 * @param {{ platform?: string }} [opts]
 * @returns {{ env: object, created: object[], warned: string[] }} the env to build hosts against,
 *          every fake watcher constructed, and every line the hosts warned
 */
export function fakeWatchEnv({ platform = 'linux' } = {}) {
  const created = []
  const warned = []
  const engine = {
    watch(targets, opts) {
      const w = new EventEmitter()
      w.opts = opts || {}
      w.targets = Array.isArray(targets) ? [...targets] : targets ? [targets] : []
      w.closed = false
      w.closeError = null
      w.closeRejection = null
      w.add = (t) => { w.targets.push(t) }
      w.unwatch = (t) => { w.targets = w.targets.filter((x) => x !== t) }
      w.close = () => {
        if (w.closeError) throw w.closeError
        w.closed = true
        return w.closeRejection ? Promise.reject(w.closeRejection) : Promise.resolve()
      }
      created.push(w)
      return w
    },
  }
  const log = { warn: (...args) => warned.push(args.join(' ')), info() {}, debug() {}, error() {} }
  return { env: { engine, platform, log }, created, warned }
}

// The watchers subsystem's surface with nothing behind it, for a test that starts a subsystem on its
// own and has no watching to observe.
export const noWatchers = Object.freeze({
  watchOwned() {}, unwatchOwned() {}, watchMirror() {}, unwatchMirror() {}, watchLoose() {}, unwatchLoose() {},
})
