import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { shareDecoKey } from '../../src/shared/transfer/decoration-key.js'
import { shareDecoKey as rendererShareDecoKey } from '../../src/renderer/decoration-key.js'

// The worker emits folder-share decoration frames under this key; the renderer looks them up
// with its hand-mirrored copy. Any drift silently drops every folder progress bar.
test('decoration key: the worker and renderer builders agree', (t) => {
  for (const [shareId, relPath] of [
    ['A', 'x.bin'],
    ['share-1', 'nested/dir/x.bin'],
    ['B', 'x:y.bin'],
    ['', ''],
  ]) {
    t.is(shareDecoKey(shareId, relPath), rendererShareDecoKey(shareId, relPath), `${shareId}:${relPath}`)
  }
})

const here = path.dirname(fileURLToPath(import.meta.url))
const srcRoot = path.join(here, '..', '..', 'src')

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
