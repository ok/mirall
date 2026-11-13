import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { appDataDir, defaultDataDir, joinFor, STORE_DIR } from '../../src/shared/core/default-data-dir.js'

const pkg = JSON.parse(readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'package.json'), 'utf8'))

test('macOS keeps app data under Library/Application Support whatever the environment says', (t) => {
  const where = { platform: 'darwin', homedir: '/Users/ana' }
  t.is(appDataDir({ ...where, env: {} }), '/Users/ana/Library/Application Support')
  t.is(appDataDir({ ...where, env: { XDG_CONFIG_HOME: '/x', APPDATA: '/y' } }), '/Users/ana/Library/Application Support')
})

test('Linux reads XDG_CONFIG_HOME, and ~/.config when it is unset or empty', (t) => {
  const where = { platform: 'linux', homedir: '/home/ana' }
  t.is(appDataDir({ ...where, env: {} }), '/home/ana/.config')
  t.is(appDataDir({ ...where, env: { XDG_CONFIG_HOME: '' } }), '/home/ana/.config')
  t.is(appDataDir({ ...where, env: { XDG_CONFIG_HOME: '/srv/cfg' } }), '/srv/cfg')
})

test('Windows reads %APPDATA%, and the roaming folder under the profile when it is unset', (t) => {
  const where = { platform: 'win32', homedir: 'C:\\Users\\ana' }
  t.is(appDataDir({ ...where, env: { APPDATA: 'D:\\Roam' } }), 'D:\\Roam')
  t.is(appDataDir({ ...where, env: {} }), 'C:\\Users\\ana\\AppData\\Roaming')
})

// Electron's userData is app.getPath('appData') joined with app.name, and app.name is the
// package's productName ("Mirall"), not its npm name ("mirall"). On Linux those name two different
// folders, so a lowercase answer here would open an empty profile beside the real one. The store
// is userData/app-storage. Each literal below is the path the desktop app opens on that OS for the
// sample home, written out so a maintainer can check it against a real install.
test('the default data folder is the one the desktop app uses, on every OS', (t) => {
  t.is(pkg.productName, 'Mirall', 'the product name these literals assume')
  const productName = pkg.productName
  t.is(defaultDataDir({ platform: 'darwin', env: {}, homedir: '/Users/ana', productName }),
    '/Users/ana/Library/Application Support/Mirall')
  t.is(defaultDataDir({ platform: 'linux', env: {}, homedir: '/home/ana', productName }),
    '/home/ana/.config/Mirall')
  t.is(defaultDataDir({ platform: 'linux', env: { XDG_CONFIG_HOME: '/home/ana/.cfg' }, homedir: '/home/ana', productName }),
    '/home/ana/.cfg/Mirall')
  t.is(defaultDataDir({ platform: 'win32', env: { APPDATA: 'C:\\Users\\ana\\AppData\\Roaming' }, homedir: 'C:\\Users\\ana', productName }),
    'C:\\Users\\ana\\AppData\\Roaming\\Mirall')
  t.is(joinFor('linux', '/home/ana/.config/Mirall', STORE_DIR), '/home/ana/.config/Mirall/app-storage')
  t.is(joinFor('win32', 'C:\\Users\\ana\\AppData\\Roaming\\Mirall', STORE_DIR), 'C:\\Users\\ana\\AppData\\Roaming\\Mirall\\app-storage')
})

test('a trailing separator on a part never doubles one', (t) => {
  t.is(joinFor('linux', '/home/ana/', '.config/'), '/home/ana/.config')
  t.is(joinFor('win32', 'C:\\Users\\ana\\', 'AppData'), 'C:\\Users\\ana\\AppData')
  t.is(joinFor('linux', '/', '.config'), '/.config')
})
