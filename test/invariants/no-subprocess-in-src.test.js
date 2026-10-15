import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const SRC = path.join(here, '..', '..', 'src')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// The data layer runs headless one day, and a child process that opens a file manager is the one
// kind of work it cannot do there. Anything that has to touch the desktop is answered to the client
// and done by it (src/renderer/platform/reveal-client.js, src/main/notifications.js). Electron main
// is the host and may spawn.
test('nothing outside src/main spawns a subprocess', (t) => {
  const offenders = walk(SRC)
    .filter((f) => !f.startsWith(path.join(SRC, 'main') + path.sep))
    .filter((f) => /['"]bare-subprocess['"]|['"](node:)?child_process['"]/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(SRC, f))
  t.alike(offenders, [], 'files that spawn from the shared, worker, preload or renderer layer')
})
