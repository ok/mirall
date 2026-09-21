import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const RENDERER = path.resolve(here, '../../src/renderer')
const OWNER = 'hooks/useClipboardCopy.ts'

function sources(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) {
      if (name !== 'locales') sources(p, out)
    } else if (/\.(ts|tsx|js)$/.test(name) && !name.endsWith('.d.ts')) out.push(p)
  }
  return out
}

const files = sources(RENDERER).map((f) => ({
  rel: path.relative(RENDERER, f).split(path.sep).join('/'),
  src: readFileSync(f, 'utf8'),
}))

// REGRESSION (FIX-375: two copy controls fired navigator.clipboard.writeText without awaiting it
// and said "Copied!" before the write resolved, so a rejected write — focus lost, permission
// refused — told the user it worked and they pasted nothing.)
test('REGRESSION (FIX-375: the clipboard has one owner, and it awaits the write)', (t) => {
  const writers = files.filter((f) => /clipboard\.writeText\(/.test(f.src)).map((f) => f.rel)
  t.alike(writers, [OWNER], `only ${OWNER} writes the clipboard`)
  const owner = files.find((f) => f.rel === OWNER)
  t.ok(owner && /await navigator\.clipboard\.writeText\(/.test(owner.src), 'and it awaits the write before reporting Copied')
})
