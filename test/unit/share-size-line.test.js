import test from 'brittle'
import { shareSizeLine } from '../../src/renderer/shareSizeLine.js'

// Minimal i18next stand-in for the three keys the size line composes.
const t = (key, opts = {}) => {
  if (key === 'share.sharedByYou') return 'Shared by you'
  if (key === 'share.ownedBy') return `Owned by ${opts.name}`
  if (key === 'share.fileCountAndSize') return `${opts.count} files · ${opts.size}`
  throw new Error(`unexpected key ${key}`)
}

test('REGRESSION (FIX-SHARECARD-DOUBLE-LABEL): own share without folder info reads "Shared by you"', (assert) => {
  const line = shareSizeLine({ isYou: true, ownerName: 'Me', fileCount: null, size: '—' }, t)
  assert.is(line, 'Shared by you', 'must not nest one owner label inside the other')
})

test('foreign share without folder info reads "Owned by {name}"', (assert) => {
  assert.is(shareSizeLine({ isYou: false, ownerName: 'Alice', fileCount: null, size: '—' }, t), 'Owned by Alice')
  assert.is(shareSizeLine({ isYou: false, ownerName: null, fileCount: null, size: '—' }, t), 'Owned by ?', 'unknown owner falls back to ?')
})

test('own share with folder info appends "Shared by you" after the counts', (assert) => {
  const line = shareSizeLine({ isYou: true, ownerName: 'Me', fileCount: 3, size: '1.2 MB' }, t)
  assert.is(line, '3 files · 1.2 MB · Shared by you')
})

test('foreign share with folder info appends "Owned by {name}" after the counts', (assert) => {
  const line = shareSizeLine({ isYou: false, ownerName: 'Alice', fileCount: 3, size: '1.2 MB' }, t)
  assert.is(line, '3 files · 1.2 MB · Owned by Alice')
})
