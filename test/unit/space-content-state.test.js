import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { showSpaceEmptyState, showSpaceLoading } from '../../src/renderer/spaceContentState.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const rendererDir = path.join(here, '..', '..', 'src', 'renderer')
const read = (...p) => readFileSync(path.join(rendererDir, ...p), 'utf8')

const settled = { filesLoading: false, sharesLoading: false, filesError: null, fileCount: 0, shareCount: 0 }

test('showSpaceEmptyState: a settled space with neither files nor folders is empty', (t) => {
  t.ok(showSpaceEmptyState(settled))
})

test('showSpaceEmptyState: any row on either axis is content, not emptiness', (t) => {
  t.absent(showSpaceEmptyState({ ...settled, fileCount: 3 }))
  t.absent(showSpaceEmptyState({ ...settled, shareCount: 1 }))
})

test('REGRESSION (FIX-367): the empty hero stays down while the SHARES read is still in flight', (t) => {
  // The flash. useFiles serves a revisited space from its listing cache, so filesLoading is
  // already false on the first frame while share:list is still draining peer drives — a space
  // whose content is entirely folder shares therefore looked empty, and the "nothing shared
  // yet" hero plus its docs card painted for the few hundred ms until the shares landed.
  t.absent(showSpaceEmptyState({ ...settled, sharesLoading: true }))
  t.absent(showSpaceEmptyState({ ...settled, filesLoading: true }))
  t.absent(showSpaceEmptyState({ ...settled, filesLoading: true, sharesLoading: true }))
})

test('showSpaceEmptyState: a failed file listing is unknown, not empty', (t) => {
  // The files section owns that case with its own retry card; claiming "nothing shared yet"
  // over a listing that never arrived would be a lie.
  t.absent(showSpaceEmptyState({ ...settled, filesError: 'IPC timeout' }))
})

test('showSpaceLoading: files loading shows the indicator even under folder cards', (t) => {
  t.ok(showSpaceLoading({ ...settled, filesLoading: true, shareCount: 2 }))
})

test('REGRESSION (FIX-367): an unsettled shares read holds the indicator instead of blanking', (t) => {
  // The other side of the same window: with the hero correctly suppressed, a pane that has
  // nothing to show yet must keep saying "loading", not go blank until the shares arrive.
  t.ok(showSpaceLoading({ ...settled, sharesLoading: true }))
  t.absent(showSpaceLoading(settled), 'a settled empty pane is not loading')
})

test('showSpaceLoading: already-rendered content is never replaced by the indicator', (t) => {
  // The indicator is a ternary branch above the file list, so returning true here would pull
  // cached rows off the screen on every shares revalidation.
  t.absent(showSpaceLoading({ ...settled, sharesLoading: true, fileCount: 4 }))
  t.absent(showSpaceLoading({ ...settled, sharesLoading: true, shareCount: 1 }))
})

// The two gates below can only be wrong at the call site, so pin the wiring by source
// (mirrors test/unit/foreign-resume-wiring.test.js) — a refactor that reverts either one
// reopens the flash with every predicate test still green.

test('REGRESSION (FIX-367): SpaceView decides both gates through the two-source predicates', (t) => {
  const src = read('screens', 'SpaceView.tsx')
  t.ok(/loading: sharesLoading \} = useShares\(/.test(src), 'the shares loading flag is consumed')
  t.ok(/showSpaceEmptyState\(pane\)/.test(src), 'the empty hero is gated by the predicate')
  t.ok(/showSpaceLoading\(pane\)/.test(src), 'the loading indicator is gated by the predicate')
  t.absent(/!loading && !error && shares\.length === 0/.test(src), 'the single-source gate is gone')
})

test('REGRESSION (FIX-367): the space list holds its empty hero until spaces:list settles', (t) => {
  const src = read('screens', 'SharedSpaces.tsx')
  for (const m of src.match(/\{[^\n]*filteredSpaces\.length === 0[^\n]*/g) ?? []) {
    t.ok(/!loading &&/.test(m), `gated on loading: ${m.trim()}`)
  }
})

test('REGRESSION (FIX-367): both list hooks survive a remount without refetching from zero', (t) => {
  // The cache is what makes a revisit render instantly; without it the gates above merely
  // trade the empty hero for a "Loading files…" flash on every space switch.
  const shares = read('hooks', 'useShares.ts')
  t.ok(/const shareCache = new Map/.test(shares), 'useShares keeps a cross-mount cache')
  t.ok(/shareCache\.set\(spaceId/.test(shares), 'a fresh read populates it')
  t.ok(/useState\(\(\) => !shareCache\.has\(spaceId\)\)/.test(shares), 'a cached space does not report loading')
  t.absent(/setLoading\(true\)\n\s+try \{/.test(shares), 'an event-driven refresh never re-opens the loading window')

  t.ok(/pruneShareCache/.test(shares), 'a departed space drops its cached rows')

  const spaces = read('hooks', 'useSpaces.ts')
  t.ok(/let spacesCache/.test(spaces), 'useSpaces keeps a cross-mount cache')
  t.ok(/useState\(\(\) => spacesCache === null\)/.test(spaces), 'a warm cache does not report loading')
  t.ok(/finally \{\s*\n\s*setLoading\(false\)/.test(spaces), 'a rejected list still settles loading')
  t.ok(/pruneShareCache\(data\.map/.test(spaces), 'the roster drives the share-cache pruning')
})
