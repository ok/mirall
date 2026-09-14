import test from 'brittle'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = (rel) => readFileSync(path.resolve(here, '../../src/renderer', rel), 'utf8')

// FolderScreen is keyed per share, and three separate pieces of state depend on that being true:
// useShareFiles folds each listing from emptyFold, useTreeExpansion seeds its expanded set once at
// mount from a per-share store, and FolderScreen's preFilterRef snapshots the expansion a filter is
// about to disturb. None of them re-reads its share afterwards.
//
// Pinned here because the failure is silent and untested end-to-end: no scenario switches between
// two DIFFERENT folders, so a dropped key surfaces only as one folder's rows unioned into another's
// first incomplete listing, or as folder A's expansion written into folder B's store slot. The key
// lives in a switch arm three files away from the state it protects, which is exactly the kind of
// line a later refactor removes without noticing.
test('the router keys FolderScreen by share', (t) => {
  const router = src('ScreenRouter.tsx')
  // `<FolderViewRoute` — the wrapper that resolves the share id against the live listing — sits
  // above the screen itself and shares its opening characters, so the tag is matched on a word
  // boundary. A plain indexOf finds the wrapper and reports a missing key that is right there.
  const at = router.search(/<FolderScreen\b(?!Route)/)
  t.ok(at > 0, 'found the FolderScreen render — a moved tag would make the rest vacuous')
  const tag = router.slice(at, router.indexOf('>', at))
  t.ok(/key=\{share\.id\}/.test(tag), 'rendered with key={share.id}')
})

test('nothing re-clears share state during render now that the key does it', (t) => {
  // useIndexProgress keeps its render-phase reset on purpose: `live` and `ownerKey` flip in place
  // while one folder stays open, which no key can cover. What must not come back is a reset keyed
  // on the SHARE, because that is the invariant the router now owns.
  t.absent(/FolderScreen is reused/.test(src('hooks/useShareFiles.ts')),
    'useShareFiles no longer resets its fold on a share change')
  t.absent(/resetFold/.test(src('shareFilesFold.js')), 'and the fold has no reset to call')
  t.ok(/live\]\.join|live \]\.join|, live\]/.test(src('hooks/useIndexProgress.ts')),
    'useIndexProgress still watches liveness, which changes without a remount')
})
