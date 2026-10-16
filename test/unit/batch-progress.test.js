import test from 'brittle'
import { deriveBatchProgress } from '../../src/renderer/model/batch-progress.js'

const rows = (list) => new Map(list.map(([key, status, size, got = 0]) => [key, { key, status, size, got }]))
const bytesOf = (row) => row.got

test('all waiting → pct 0 and every file counted', (t) => {
  const r = rows([['a', 'waiting', 100], ['b', 'waiting', 100], ['c', 'waiting', 100]])
  t.alike(deriveBatchProgress(['a', 'b', 'c'], r, bytesOf), { files: 3, done: 0, bytesLeft: 300, pct: 0 })
})

test('half done gives the right pct, done count and bytes left', (t) => {
  const r = rows([['a', 'downloaded', 100], ['b', 'downloading', 100, 50], ['c', 'waiting', 100]])
  t.alike(deriveBatchProgress(['a', 'b', 'c'], r, bytesOf), { files: 3, done: 1, bytesLeft: 150, pct: 50 })
})

test('a row that left the listing is skipped', (t) => {
  const r = rows([['a', 'downloading', 100, 10]])
  t.alike(deriveBatchProgress(['a', 'gone'], r, bytesOf), { files: 1, done: 0, bytesLeft: 90, pct: 10 })
})

test('no live rows → null, which is also the everything-failed and everything-done case', (t) => {
  t.is(deriveBatchProgress(['a', 'b'], rows([['a', 'error', 100], ['b', 'downloaded', 100]]), bytesOf), null)
  t.is(deriveBatchProgress(['a'], rows([['a', 'remote', 100]]), bytesOf), null, 'an available row is not live once the start window has passed')
  t.is(deriveBatchProgress([], rows([]), bytesOf), null)
})

test('right after a start an available row still counts as live, so the strip shows at once', (t) => {
  const r = rows([['a', 'remote', 100], ['b', 'downloaded', 100]])
  t.alike(deriveBatchProgress(['a', 'b'], r, bytesOf, { recent: true }), { files: 2, done: 1, bytesLeft: 100, pct: 50 })
})

test('a zero-byte batch gives no NaN', (t) => {
  t.alike(deriveBatchProgress(['a'], rows([['a', 'waiting', 0]]), bytesOf), { files: 1, done: 0, bytesLeft: 0, pct: 0 })
})
