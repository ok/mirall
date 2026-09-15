import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { fixAsarPath, installAsarSpawnFix } from '../../src/main/asar-spawn.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const mainSrc = readFileSync(path.join(here, '..', '..', 'src', 'main', 'main.js'), 'utf8')

test('fixAsarPath rewrites app.asar path segments to app.asar.unpacked', (t) => {
  t.is(fixAsarPath('/Mirall.app/Contents/Resources/app.asar/node_modules/bare-runtime/bin/bare'),
    '/Mirall.app/Contents/Resources/app.asar.unpacked/node_modules/bare-runtime/bin/bare')
  t.is(fixAsarPath('C:\\Mirall\\resources\\app.asar\\src\\worker\\main.js'),
    'C:\\Mirall\\resources\\app.asar.unpacked\\src\\worker\\main.js')
  t.is(fixAsarPath('/repo/src/worker/main.js'), '/repo/src/worker/main.js', 'a non-asar path is untouched')
  t.is(fixAsarPath(undefined), undefined, 'a non-string passes through')
})

test('installAsarSpawnFix translates the file and argv a caller hands spawn', (t) => {
  const seen = []
  const cp = { spawn(file, args, options) { seen.push({ file, args, options }); return 'child' } }
  installAsarSpawnFix(cp)
  const options = { stdio: 'pipe' }
  t.is(cp.spawn('/x/app.asar/bin/bare', ['/x/app.asar/src/worker/main.js', '--flag'], options), 'child')
  t.alike(seen, [{
    file: '/x/app.asar.unpacked/bin/bare',
    args: ['/x/app.asar.unpacked/src/worker/main.js', '--flag'],
    options,
  }])
})

// The patch only reaches a spawn taken AFTER it is installed. bare-sidecar (under pear-runtime,
// under updater.js) destructures `spawn` at load, so a require of any main module that can reach
// pear-runtime ahead of the install leaves the sidecar holding the original: in a packaged build
// the bare binary is then spawned at its app.asar path and fails with ENOTDIR. The ordering of two
// statements in the entry is the whole invariant, so it is pinned structurally.
test('REGRESSION (FIX-SPAWN-1): the asar spawn fix is installed before any module that can reach pear-runtime', (t) => {
  const install = mainSrc.search(/^require\('\.\/asar-spawn\.js'\)\.installAsarSpawnFix\(\)$/m)
  t.ok(install >= 0, 'main.js installs the fix at module top')
  const firstLocalRequire = mainSrc.search(/require\('\.\/(?!asar-spawn\.js')/)
  t.ok(firstLocalRequire >= 0, 'main.js requires its sibling modules')
  t.ok(install >= 0 && install < firstLocalRequire, 'the install precedes the first sibling require')
  t.is(mainSrc.search(/require\('pear-runtime'\)/), -1, 'main.js does not require pear-runtime itself')
})
