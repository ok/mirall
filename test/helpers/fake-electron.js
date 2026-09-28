// A stand-in for the electron module, so src/main's CommonJS modules can be driven under plain
// Node. It exists for the same reason fake-watcher.js does: one model of the surface main uses,
// rather than a different ad-hoc double in each test file.
//
// Only what src/main actually reaches is modelled. A property nobody has needed yet is absent on
// purpose — a test that trips over one should add it here, so the model stays a description of the
// real coupling rather than a blanket Proxy that hides it.
import { createRequire } from 'module'
import { EventEmitter } from 'events'
import path from 'path'
import { fileURLToPath } from 'url'

const require = createRequire(import.meta.url)
const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

export function makeFakeElectron(overrides = {}) {
  const handlers = new Map()
  const sent = []
  const ipcMain = {
    handle: (channel, fn) => { handlers.set(channel, fn) },
    removeHandler: (channel) => { handlers.delete(channel) },
    on: (channel, fn) => { handlers.set(channel, fn) },
    invoke: (channel, ...args) => handlers.get(channel)?.({}, ...args),
    handlers,
  }
  const webContentsList = []
  return {
    ipcMain,
    sent,
    webContents: {
      getAllWebContents: () => webContentsList,
      list: webContentsList,
    },
    app: {
      getPath: (name) => path.join(root, '.test-paths', name),
      getAppPath: () => root,
      quit: () => {},
      ...overrides.app,
    },
    dialog: { showErrorBox: () => {}, showOpenDialog: async () => ({ canceled: true, filePaths: [] }) },
    BrowserWindow: { getAllWindows: () => [] },
    nativeTheme: new EventEmitter(),
    ...overrides,
  }
}

/**
 * Load repo-relative CommonJS modules with `electron` stubbed out.
 *
 * @param {string[]} relPaths  modules to (re)load, dependencies first
 * @param {object} [overrides] partial electron surface to merge over the default fake
 * @returns {{ electron: object, modules: object[] }}
 */
export function loadWithFakeElectron(relPaths, overrides) {
  const electron = makeFakeElectron(overrides)
  // Under plain Node, require('electron') resolves to the npm package's index.js (a path string),
  // so the cache has to be primed at that resolved path — not under the bare name.
  const electronPath = require.resolve('electron')
  const prev = require.cache[electronPath]
  require.cache[electronPath] = { id: electronPath, filename: electronPath, loaded: true, exports: electron }
  const modules = []
  try {
    for (const rel of relPaths) {
      const abs = require.resolve(path.join(root, rel))
      delete require.cache[abs]
      modules.push(require(abs))
    }
  } finally {
    if (prev) require.cache[electronPath] = prev
    else delete require.cache[electronPath]
  }
  return { electron, modules }
}
