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
    `the diff half beats on entry and inside the phase that awaits (found ${beats(diffAndEnqueue)})`)

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

// REGRESSION (FIX-OWNER-HEARTBEAT-2: the beat added to the diff went into the loop over `onDisk`,
// which is fully synchronous. On the worker's single thread nothing can run between that loop's
// iterations, so only the stamps on either side of it are ever read and the beat was unobservable —
// it made the phase look covered without covering anything. Meanwhile the one phase of the diff
// that DOES yield got none: ensureServable is free only while the serve reference is present, and
// after a restart the serve map is empty, so a large fully-synced share routes every unchanged file
// through registerFile. Past the stall window that healthy pass reported as a folder scan that was
// not advancing — the exact false verdict the heartbeat exists to prevent.
//
// Pinned by structure, not by a count: a count of beats cannot tell an observable one from a dead
// one, which is how the first fix passed its own test.)
test('REGRESSION (FIX-OWNER-HEARTBEAT-2): the phase that awaits per file is the one that beats', (t) => {
  const loop = /for \(const \[relPath, prev, info\] of unchanged\) \{([\s\S]*?)\n  \}/.exec(src)
  t.ok(loop, 'found the self-heal loop over unchanged files')
  t.ok(/await ensureServable\(/.test(loop[1]),
    'it awaits per file — which is what makes a beat inside it observable at all')
  t.ok(/passLiveness\.progress\(key\)/.test(loop[1]),
    'so it beats INSIDE the loop, not merely on either side of it')
})
