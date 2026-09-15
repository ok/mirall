import test from 'brittle'
import { entryTally } from '../../src/shared/shares/catalog-tally.js'

const entry = (relPath, size = 1) => ({ relPath, size, mtime: 0, contentHash: null })

test('entryTally: the cap retains the first rows and still counts every entry', (t) => {
  const tally = entryTally(2)
  for (const e of [entry('a', 1), entry('b', 2), entry('c', 3)]) tally.add(e)
  const { entries, total, totalBytes } = tally.result()
  t.alike(entries.map((e) => e.relPath), ['a', 'b'])
  t.is(total, 3)
  t.is(totalBytes, 6)
})

test('entryTally: a non-finite size counts but does not sum', (t) => {
  const tally = entryTally()
  tally.add(entry('a', 5))
  tally.add(entry('b', NaN))
  tally.add({ relPath: 'c', mtime: 0, contentHash: null })
  const { total, totalBytes } = tally.result()
  t.is(total, 3)
  t.is(totalBytes, 5)
})

test('entryTally: an escaping path is in neither the count nor the rows', (t) => {
  const tally = entryTally()
  t.is(tally.add(entry('../escape')), false)
  t.is(tally.add(entry('ok')), true)
  const { entries, total } = tally.result()
  t.alike(entries.map((e) => e.relPath), ['ok'])
  t.is(total, 1)
})

test('entryTally: onEach sees every counted entry past the cap', (t) => {
  const seen = []
  const tally = entryTally(1, (e) => seen.push(e.relPath))
  for (const e of [entry('a'), entry('../x'), entry('b')]) tally.add(e)
  t.alike(seen, ['a', 'b'])
  t.is(tally.result().entries.length, 1)
})
