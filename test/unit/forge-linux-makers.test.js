import test from 'brittle'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'

const require = createRequire(import.meta.url)
const CONFIG = require.resolve('../../forge.config.js')
const pkg = require('../../package.json')

// forge.config.js reads the environment at module scope; it is swapped wholesale so a developer's
// APPLE_* cannot leak in, and the module cache is cleared on both sides of the load.
function loadConfig() {
  const saved = process.env
  process.env = { UPGRADE_KEY: 'none' }
  try {
    delete require.cache[CONFIG]
    return require(CONFIG)
  } finally {
    process.env = saved
    delete require.cache[CONFIG]
  }
}

test('the deb maker names the package, the executable and the scheme handler the rest of the tree uses', (t) => {
  const cfg = loadConfig()
  const deb = cfg.makers.find((m) => m.name === '@electron-forge/maker-deb')
  t.ok(deb, 'maker present')
  t.alike(deb.platforms, ['linux'])
  const o = deb.config.options
  t.is(o.name, pkg.name, 'Package: is the lower-case package name')
  t.is(o.bin, cfg.packagerConfig.executableName, 'bin names the capitalised binary or /usr/bin/<name> dangles')
  t.alike(o.mimeType, [`x-scheme-handler/${pkg.name}`], 'the deep-link scheme is declared statically')
  t.ok(/^[^<]+ <[^@>]+@[^>]+>$/.test(o.maintainer), 'Maintainer carries an email')
  t.ok(o.description, 'Description is set (the installer refuses a package without one)')
  t.absent(o.scripts, 'no maintainer scripts')
  t.absent(o.depends, 'Depends stays the installer default for the packaged Electron version')
  t.is(o.compression, 'xz', 'xz members: dpkg before Debian 12 cannot unpack zstd')
  const iconDir = path.dirname(new URL('../../resources/linux/icons/16x16.png', import.meta.url).pathname)
  const onDisk = fs.readdirSync(iconDir).filter((f) => /^\d+x\d+\.png$/.test(f)).map((f) => f.slice(0, -4)).sort()
  t.alike(Object.keys(o.icon).sort(), onDisk, 'every <size>x<size>.png in resources/linux/icons ships, and nothing else')
  for (const [size, file] of Object.entries(o.icon)) {
    t.ok(fs.existsSync(file), `icon ${size} exists`)
    t.ok(file.endsWith(`/${size}.png`), `icon ${size} is the matching source file`)
  }
})

test('the packaged Linux tree gets the app licence at its root, where the deb reads its copyright from', async (t) => {
  const cfg = loadConfig()
  const hook = cfg.packagerConfig.afterComplete[0]
  const run = (buildPath, platform) => new Promise((resolve, reject) => {
    hook(buildPath, '42.0.0', platform, 'x64', (err) => (err ? reject(err) : resolve()))
  })
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-license-'))
  t.teardown(() => fs.rmSync(dir, { recursive: true, force: true }))
  fs.writeFileSync(path.join(dir, 'LICENSE'), 'MIT (Electron)')

  await run(dir, 'darwin')
  t.is(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), 'MIT (Electron)', 'other platforms are untouched')

  await run(dir, 'linux')
  const ours = fs.readFileSync(new URL('../../LICENSE', import.meta.url), 'utf8')
  t.is(fs.readFileSync(path.join(dir, 'LICENSE'), 'utf8'), ours, 'root LICENSE is the app licence')
  t.is(fs.readFileSync(path.join(dir, 'LICENSE.electron.txt'), 'utf8'), 'MIT (Electron)', "Electron's text is kept under its own name")
})

test('make:linux runs forge make before the AppImage script, so preMake\'s out/make wipe cannot eat the AppImage', (t) => {
  const script = pkg.scripts['make:linux']
  const make = script.indexOf('electron-forge make --platform=linux')
  const appimage = script.indexOf('scripts/build/build-app-image.sh')
  t.ok(make >= 0, 'uses `make`, not `package`: `package` never runs a maker')
  t.ok(appimage > make, 'the AppImage is assembled after the makers')
})

test('the AppImage script never removes out/make, where the deb already sits', (t) => {
  const src = fs.readFileSync(new URL('../../scripts/build/build-app-image.sh', import.meta.url), 'utf8')
  t.absent(/rm\s+-rf?\s+"?\$(OUT_DIR|ROOT\/out\/make)/.test(src))
})
