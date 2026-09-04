import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { shareDecoKey } from '../../src/shared/transfer/decoration-key.js'
import { shareDecoKey as rendererShareDecoKey } from '../../src/renderer/decoration-key.js'
import { shareDecoKey as contractShareDecoKey } from '../../src/shared/contract/decoration-key.js'

// The worker emits folder-share decoration frames under this key and the renderer looks them up
// with it, so any disagreement silently drops every folder progress bar. This used to diff two
// hand-maintained copies; both sides now re-export the contract package, so the divergence it
// watched for cannot occur and what is worth guarding is that the twin does not come back.
test('the worker and renderer builders are the same function', (t) => {
  t.is(shareDecoKey, contractShareDecoKey, 'the data layer re-exports rather than wraps')
  t.is(rendererShareDecoKey, contractShareDecoKey, 'the renderer re-exports rather than wraps')
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
