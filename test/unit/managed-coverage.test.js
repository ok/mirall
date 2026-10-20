import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { CATALOG_KEYS, KNOWN_SETTINGS } from '../../src/shared/managed/catalog.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = path.join(here, '..', '..', 'src')

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) sources(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(readFileSync(p, 'utf8'))
  }
  return out
}
const read = (dir) => sources(dir).join('\n')

const renderer = read(path.join(src, 'renderer'))
const setters = read(path.join(src, 'worker', 'ipc'))
const FOLDER = /^backup\.folder\./

// A managed setting can't ship without a lock in the UI, and a typo can't hide one: every key this
// build applies is named where a control is locked, and every key named there is in the catalog. The
// backup folder keys lock through the folder the worker resolved for this device's own platform.
test('every applied key is locked somewhere in the UI', (t) => {
  for (const key of KNOWN_SETTINGS) {
    const named = renderer.includes(`settingKey="${key}"`) || renderer.includes(`useManagedSetting('${key}')`)
    t.ok(named || (FOLDER.test(key) && renderer.includes('useManagedBackupFolder()')), key)
  }
  for (const [, key] of renderer.matchAll(/(?:settingKey="|useManagedSetting\(')([a-zA-Z.]+)/g)) t.ok(CATALOG_KEYS.includes(key), key)
})

test('every applied key is guarded in a setter', (t) => {
  for (const key of KNOWN_SETTINGS) {
    t.ok(setters.includes(`assertUnlocked('${key}'`) || (FOLDER.test(key) && setters.includes('assertUnlocked(backupFolderKey(')), key)
  }
})
