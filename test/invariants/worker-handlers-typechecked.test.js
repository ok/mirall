import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const WORKER = path.join(root, 'src', 'worker')
const IPC = path.join(WORKER, 'ipc')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (name.endsWith('.js')) out.push(p)
  }
  return out
}

// tsconfig.worker.json leaves checkJs off, so a handler is held to its contract row only if its file
// opts in. The rule is one sentence: every ipc.handle lives in src/worker/ipc/, and every file there
// opens with // @ts-check.
test('every handler module is type-checked', (t) => {
  const files = walk(IPC)
  t.ok(files.length >= 10, `${files.length} handler modules`)
  const unchecked = files.filter((f) => !readFileSync(f, 'utf8').startsWith('// @ts-check\n'))
  t.alike(unchecked.map((f) => path.relative(root, f)), [], 'handler modules without // @ts-check on their first line')
})

// A later directive undoes the first line, so the folder carries none: an error in a handler module
// is fixed, not silenced.
test('nothing in the checked folder switches the check off', (t) => {
  const silenced = walk(IPC)
    .filter((f) => /@ts-(nocheck|ignore|expect-error)\b/.test(readFileSync(f, 'utf8')))
  t.alike(silenced.map((f) => path.relative(root, f)), [], 'handler modules carrying @ts-nocheck, @ts-ignore or @ts-expect-error')
})

test('no handler is registered outside the checked folder', (t) => {
  const outside = walk(WORKER)
    .filter((f) => !f.startsWith(IPC + path.sep))
    .filter((f) => /\bipc\.handle\(/.test(readFileSync(f, 'utf8')))
  t.alike(outside.map((f) => path.relative(root, f)), [], 'files outside src/worker/ipc that register a handler')
})
