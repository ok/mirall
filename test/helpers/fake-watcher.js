// A synchronous stand-in for the file watcher package (chokidar4bare), shared by every test that
// reaches src/main's watchers.
// Real fsevents timing plus awaitWriteFinish makes an fs-watch test slow and flaky, and a unit
// test must not touch the filesystem at all — so each fake watcher is an EventEmitter the test
// emits on directly. It lives here rather than in each test file for the same reason
// watch-host.js exists: one model of the watcher surface, so the tests cannot drift from each
// other about what that surface is.
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

/**
 * Load repo-relative CommonJS modules with `chokidar4bare` stubbed out.
 *
 * @param {string[]} relPaths  modules to (re)load, dependencies first
 * @returns {{ created: object[], modules: object[] }} every fake watcher constructed, and the
 *          loaded module exports in the order requested
 */
export function loadWithFakeWatcher(relPaths) {
  const created = []
  const fakeWatcher = {
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

  const watcherPath = require.resolve('chokidar4bare')
  const prev = require.cache[watcherPath]
  require.cache[watcherPath] = { id: watcherPath, filename: watcherPath, loaded: true, exports: fakeWatcher }
  const modules = []
  try {
    for (const rel of relPaths) {
      const abs = require.resolve(path.join(root, rel))
      delete require.cache[abs]
      modules.push(require(abs))
    }
  } finally {
    // Restore the real watcher in the shared require cache — the modules above already
    // captured the fake, so nothing else in a shared test process is affected.
    if (prev) require.cache[watcherPath] = prev
    else delete require.cache[watcherPath]
  }
  return { created, modules }
}
