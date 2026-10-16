import test from 'brittle'
import { createRequire } from 'module'
import { loadWithFakeElectron } from '../helpers/fake-electron.js'

const require = createRequire(import.meta.url)

// The download-folder picker answers a name as its volume stores it, which on macOS is often
// decomposed (NFD), while the worker keeps download folders in NFC. Elsewhere the two spellings can
// name two different folders, so the pick is passed on as it came.
const DECOMPOSED = '/Users/me/Bücher'
const COMPOSED = '/Users/me/Bücher'

// The platform is read once, at load, so it is set before the module loads.
function browseOn(t, { isMac }, picked) {
  const runtimePath = require.resolve('which-runtime')
  const prev = require.cache[runtimePath]
  require.cache[runtimePath] = { id: runtimePath, filename: runtimePath, loaded: true, exports: { isMac, isLinux: !isMac, isWindows: false } }
  let loaded
  try {
    loaded = loadWithFakeElectron(['src/main/settings-ipc.js'], {
      dialog: { showErrorBox: () => {}, showOpenDialog: async () => ({ canceled: false, filePaths: [picked] }) },
    })
  } finally {
    if (prev) require.cache[runtimePath] = prev
    else delete require.cache[runtimePath]
  }
  t.teardown(() => { delete require.cache[require.resolve('../../src/main/settings-ipc.js')] })
  const [settingsIpc] = loaded.modules
  settingsIpc.registerSettingsIpc({ createTray: () => {}, destroyTray: () => {}, applyAppMenuVisibility: () => {}, targetWindow: () => null })
  return () => loaded.electron.ipcMain.handlers.get('downloads:browse')({}, undefined)
}

test('REGRESSION (FIX-DLTO-R17: the picker handed the worker macOS\'s decomposed names): a picked download folder arrives in NFC on macOS', async (t) => {
  const browse = browseOn(t, { isMac: true }, DECOMPOSED)
  t.is(await browse(), COMPOSED)
})

test('a picked download folder is passed on as it came elsewhere', async (t) => {
  const browse = browseOn(t, { isMac: false }, DECOMPOSED)
  t.is(await browse(), DECOMPOSED)
})

test('a cancelled pick answers null', async (t) => {
  const runtimeFree = loadWithFakeElectron(['src/main/settings-ipc.js'])
  t.teardown(() => { delete require.cache[require.resolve('../../src/main/settings-ipc.js')] })
  runtimeFree.modules[0].registerSettingsIpc({ createTray: () => {}, destroyTray: () => {}, applyAppMenuVisibility: () => {}, targetWindow: () => null })
  t.is(await runtimeFree.electron.ipcMain.handlers.get('downloads:browse')({}, undefined), null)
})
