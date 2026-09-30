import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const rel = (p) => path.relative(root, p).split(path.sep).join('/')
const ENGINE = 'src/shared/transfer/backends/overlay/engine/'
const DOOR = 'src/shared/transfer/backends/overlay/overlay-journals.js'

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|mjs|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

const appFiles = () => walk(path.join(root, 'src')).map((p) => [rel(p), readFileSync(p, 'utf8')]).filter(([file]) => !file.startsWith(ENGINE))

// The engine owns the journal's name and format, the app owns where journals live: one app door,
// so a caller asks by final path and never builds a journal path itself.
test('only overlay-journals.js imports the engine journal module', (t) => {
  const importers = appFiles().filter(([, src]) => /from\s*['"][^'"]*engine\/transfer\/journal\.js['"]/.test(src)).map(([file]) => file)
  t.alike(importers, [DOOR], 'overlay-journals.js is the one importer, and it is found')
})

test('no app file names the journal file-name function', (t) => {
  t.alike(appFiles().filter(([, src]) => /\bjournalNameFor\b/.test(src)).map(([file]) => file), [])
})
