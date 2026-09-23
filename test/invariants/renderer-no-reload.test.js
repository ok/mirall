import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const rendererDir = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'src', 'renderer')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'locales') walk(p, out) }
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(p)
  }
  return out
}

// Recovering from a worker restart by reloading the window takes the user back to the space list
// and wipes everything they have not submitted. The store resyncs in place instead. The one
// legitimate reload is applying a new build, which is a new renderer by definition.
const ALLOWED = ['platform/updates.ts']

test('the renderer reloads itself only to apply a new build', (t) => {
  const files = walk(rendererDir)
  t.ok(files.length > 100, 'src/renderer was actually walked')
  const offenders = files
    .filter((f) => /location\.reload\s*\(/.test(readFileSync(f, 'utf8')))
    .map((f) => path.relative(rendererDir, f).split(path.sep).join('/'))
    .filter((f) => !ALLOWED.includes(f))
  t.alike(offenders, [])
})
