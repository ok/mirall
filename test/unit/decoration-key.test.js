import test from 'brittle'
import { readFileSync, readdirSync, statSync, existsSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { shareDecoKey } from '../../src/shared/contract/decoration-key.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.join(here, '..', '..', 'src')

// The worker emits folder-share decoration frames under this key and the renderer looks them up
// with it, so any disagreement silently drops every folder progress bar. Both sides import the
// contract module directly; what is worth guarding is that neither grows a copy back.
test('neither side holds a decoration-key twin', (t) => {
  t.absent(existsSync(path.join(srcRoot, 'renderer', 'decoration-key.js')), 'the renderer imports the contract directly')
  t.absent(existsSync(path.join(srcRoot, 'shared', 'transfer', 'decoration-key.js')), 'so does the data layer')
})

test('the key still keys by share and path', (t) => {
  for (const [shareId, relPath, expected] of [
    ['A', 'x.bin', 'A:x.bin'],
    ['share-1', 'nested/dir/x.bin', 'share-1:nested/dir/x.bin'],
    ['B', 'x:y.bin', 'B:x:y.bin'],
    ['', '', ':'],
  ]) {
    t.is(shareDecoKey(shareId, relPath), expected, `${shareId}:${relPath}`)
  }
})

function walk (dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) walk(p, out)
    else if (/\.(js|ts|tsx)$/.test(name)) out.push(p)
  }
  return out
}

// CL6: folder/mirror progress rides the unified event:decoration channel; the legacy
// per-share progress event must not resurface anywhere in the source tree.
test('event:share-file-progress is fully retired from src/', (t) => {
  const offenders = walk(srcRoot).filter((p) => readFileSync(p, 'utf8').includes('event:share-file-progress'))
  t.alike(offenders.map((p) => path.relative(srcRoot, p)), [], 'no source file references the retired event')
})
