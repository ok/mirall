import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { spawn } from 'bare-subprocess'
import { trackTimers } from '../helpers/timers.js'

const here = path.dirname(import.meta.url.replace(/^file:\/\//, ''))
const shared = path.join(here, '..', '..', 'src', 'shared')

const walk = (dir, out = []) => {
  for (const name of fs.readdirSync(dir)) {
    const p = path.join(dir, name)
    if (fs.statSync(p).isDirectory()) { if (name !== 'vendor') walk(p, out) } else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// REGRESSION (LIFECYCLE-1d: importing the data layer must arm nothing. This catches what the
// static lint rule cannot — a module-level `createX()` whose body arms a timer — because the
// shim is installed before the imports run and counts what is actually alive afterwards.)
test('REGRESSION (LIFECYCLE-1d): importing every src/shared module creates zero timers', async (t) => {
  const timers = trackTimers()
  t.teardown(() => timers.restore())
  for (const file of walk(shared)) {
    try { await import(file) } catch (err) { t.fail(file + ' failed to import: ' + err.message) }
  }
  const armed = timers.intervals()
  t.is(armed.length, 0, 'no interval armed by import\n' + timers.describe(armed))
})

// The TDZ escape (lessons.md: a factory invoked during a circular import must not read its own
// module's consts). Each SCC member is imported FIRST in a fresh process — the order a single
// test process cannot reproduce is exactly the order that bit.
// The cycle is now {files, loose-overlay}: constructing the download engines in the overlay
// backend's _open cut the last edge into overlay-download.js, so it and overlay-backend.js are
// no longer in any cycle. The rest stay listed — importing them first must keep working.
const SCC = [
  'transfer/loose-overlay.js',
  'transfer/files.js',
  'transfer/backends/overlay/overlay-download.js',
  'transfer/backends/overlay/overlay-instance.js',
  'transfer/backends/overlay/overlay-backend.js',
  'transfer/backends/overlay/overlay-runtime.js',
  'folders/publish-service.js',
  'folders/owned-folders.js',
]

test('each import-cycle member can be imported first without a TDZ ReferenceError', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mirall-import-first-'))
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  for (const rel of SCC) {
    const entry = path.join(dir, rel.replace(/\//g, '-') + '.mjs')
    fs.writeFileSync(entry, `import('${path.join(shared, rel)}').then(() => Bare.exit(0), (e) => { console.error(e.stack); Bare.exit(1) })\n`)
    // Bare.argv[0] is the running bare binary.
    const code = await new Promise((resolve) => {
      const p = spawn(Bare.argv[0], [entry], { stdio: 'inherit' })
      p.on('exit', resolve)
    })
    t.is(code, 0, rel + ' imported first')
  }
})
