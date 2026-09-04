import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', '..', 'src', 'shared', 'folders', 'owned-folders.js'), 'utf8')

// owned-folders.js loads only under Bare and the heartbeat it keeps is module-private, so the wiring
// is pinned by source the way the other *-wiring tests in this directory are. The RULE it pins is
// behavioural: the supervisor reports a pass that has not advanced inside the stall window as
// wedged, so every phase of a pass has to say it is still working — not just the one that happens
// to iterate files.
function bodyOf (name) {
  const from = src.indexOf(`async function ${name}(`)
  if (from < 0) return ''
  const end = src.indexOf('\n}\n', from)
  return src.slice(from, end < 0 ? src.length : end)
}

// REGRESSION (FIX-OWNER-HEARTBEAT: the owner-side pass bumped its heartbeat only from walkDisk's
// per-file callback. The catalog settle, the catalog drain and the diff that follow it reported
// nothing, so a large but perfectly healthy share went quiet for longer than the stall window and
// diagnostics:export reported a folder scan that was not advancing.)
test('REGRESSION (FIX-OWNER-HEARTBEAT): every phase of a reconcile reports progress, not just the walk', (t) => {
  const readBothSides = bodyOf('readBothSides')
  const diffAndEnqueue = bodyOf('diffAndEnqueue')
  t.ok(readBothSides && diffAndEnqueue, 'found both halves of the pass')

  const beats = (body) => [...body.matchAll(/passLiveness\.progress\(/g)].length
  t.ok(beats(readBothSides) >= 3,
    `the read half beats after the walk, around the catalog settle and through the drain (found ${beats(readBothSides)})`)
  t.ok(beats(diffAndEnqueue) >= 2,
    `the diff half beats on entry and through its loop (found ${beats(diffAndEnqueue)})`)

  // The one that was there all along, and the reason the gap was invisible: on a share whose files
  // are the slow part it beats plenty, which is exactly the case nobody hits in a test.
  t.ok(/walkDisk\([^)]*onProgress: \(\) => passLiveness\.progress\(key\)/s.test(src),
    'the walk still beats per file')
})

test('the catalog drain beats on a bounded interval, not once per entry', (t) => {
  t.ok(/const LIVENESS_EVERY = \d+/.test(src), 'the interval is named')
  t.ok(/% LIVENESS_EVERY === 0\) passLiveness\.progress\(/.test(src),
    'so the bookkeeping cannot itself become the cost of the pass')
})
