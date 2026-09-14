import test from 'brittle'
import { readFileSync } from 'fs'
import path from 'path'
import { fileURLToPath } from 'url'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.resolve(here, '../../src/renderer/hooks/useFilteredTree.ts'), 'utf8')

// A folder's tree is rebuilt on every progress tick — a decoration frame lands several times a
// second on an indexing share — so both walks are memoized on the one input that actually changes.
// test/frontend-layout/harness-memo-entry.tsx measures the COST of getting this wrong, but it
// re-implements the memo rather than calling the hook, so it cannot see a dep the hook drops.
// This is the half that can.
test('the tree walks are memoized on their real inputs', (t) => {
  const build = src.match(/useMemo<FileTreeNode\[\]>\(\(\) => buildFileTree\(files\), \[([^\]]*)\]\)/)
  t.ok(build, 'buildFileTree is memoized — a missing memo rebuilds the tree every render')
  t.is(build?.[1].trim(), 'files', 'on [files] alone')

  const filter = src.match(/useMemo\(\(\) => filterTree\(tree, deferredFilter\), \[([^\]]*)\]\)/)
  t.ok(filter, 'filterTree is memoized')
  t.is(filter?.[1].trim(), 'tree, deferredFilter', 'on the tree and the DEFERRED term, not the typed one')

  // The typed value drives the input; the deferred one drives the walk. Filtering on `filter`
  // would re-walk 5,000 rows per keystroke, which is the thing useDeferredValue is here to avoid.
  t.absent(/filterTree\(tree, filter\)/.test(src), 'the walk never runs on the undeferred term')
})
