import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// A space's participation id is derived, and nothing the app writes lives in a Hyperdrive. The OTA
// updater still rides one, but through pear-runtime, which brings its own copy; a direct import here
// is a drive coming back into the data layer.
test('no source module opens a Hyperdrive', (t) => {
  const files = walk(SRC)
  t.ok(files.length > 100, `walked ${files.length} source files`)
  const offenders = files
    .filter((f) => /from 'hyperdrive'|require\('hyperdrive'\)/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f))
  t.alike(offenders, [], 'no import of hyperdrive under src/')
})
