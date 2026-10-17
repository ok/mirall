import test from 'brittle'
import { deriveDownloadProgress } from '../../src/renderer/model/batch-progress.js'

const rowsOf = (list) => list.map(([key, status, size, got = 0]) => ({ key, status, size, got, transferId: `t-${key}` }))
const args = (list, opts = {}) => ({ rows: rowsOf(list), keyOf: (r) => r.key, bytesOf: (r) => r.got, ...opts })

test('a batch: all waiting → pct 0 and every file counted', (t) => {
  const p = deriveDownloadProgress(args([['a', 'waiting', 100], ['b', 'waiting', 100], ['c', 'waiting', 100]], { batchKeys: ['a', 'b', 'c'] }))
  t.alike(p, { files: 3, done: 0, bytesLeft: 300, pct: 0, moving: true, batchLive: true, transferIds: ['t-a', 't-b', 't-c'] })
})

test('a batch: its finished files count as done, in the files and the percentage', (t) => {
  const p = deriveDownloadProgress(args([['a', 'downloaded', 100], ['b', 'downloading', 100, 50], ['c', 'waiting', 100]], { batchKeys: ['a', 'b', 'c'] }))
  t.alike(p, { files: 3, done: 1, bytesLeft: 150, pct: 50, moving: true, batchLive: true, transferIds: ['t-b', 't-c'] })
})

test('a batch key that left the listing is skipped', (t) => {
  const p = deriveDownloadProgress(args([['a', 'downloading', 100, 10]], { batchKeys: ['a', 'gone'] }))
  t.alike(p, { files: 1, done: 0, bytesLeft: 90, pct: 10, moving: true, batchLive: true, transferIds: ['t-a'] })
})

test('nothing under way → null, which is also the everything-failed and everything-done case', (t) => {
  t.is(deriveDownloadProgress(args([['a', 'error', 100], ['b', 'downloaded', 100]], { batchKeys: ['a', 'b'] })), null)
  t.is(deriveDownloadProgress(args([['a', 'remote', 100]], { batchKeys: ['a'] })), null, 'an available row is not under way once the start window has passed')
  t.is(deriveDownloadProgress(args([])), null)
})

test('right after a start an available batch row counts, so the strip shows at once', (t) => {
  const p = deriveDownloadProgress(args([['a', 'remote', 100], ['b', 'downloaded', 100]], { batchKeys: ['a', 'b'], recent: true }))
  t.alike(p, { files: 2, done: 1, bytesLeft: 100, pct: 50, moving: true, batchLive: true, transferIds: ['t-a'] },
    'its transfer id rides along: the engine has already started it, so Cancel All must reach it')
})

test('a zero-byte batch gives no NaN', (t) => {
  t.alike(deriveDownloadProgress(args([['a', 'waiting', 0]], { batchKeys: ['a'] })).pct, 0)
})

test('REGRESSION (FIX-STRIP-LIVE-1: a restart lost the batch): downloads under way show with no batch at all', (t) => {
  const p = deriveDownloadProgress(args([['a', 'downloading', 100, 40], ['b', 'waiting', 100], ['c', 'downloaded', 100], ['d', 'remote', 100]]))
  t.alike(p, { files: 2, done: 0, bytesLeft: 160, pct: 20, moving: true, batchLive: false, transferIds: ['t-a', 't-b'] },
    'only the files under way count: a finished or available file is not part of it without a batch')
})

test('REGRESSION (FIX-STRIP-LIVE-2: an owner going offline retired the strip): paused downloads keep it, and say so', (t) => {
  const p = deriveDownloadProgress(args([['a', 'paused-offline', 100, 30], ['b', 'paused-interrupted', 100]], { batchKeys: ['a', 'b'] }))
  t.alike(p, { files: 2, done: 0, bytesLeft: 170, pct: 15, moving: false, batchLive: true, transferIds: ['t-a', 't-b'] })
  t.is(deriveDownloadProgress(args([['a', 'paused-offline', 100], ['b', 'downloading', 100]])).moving, true, 'one moving file makes it moving')
})

test('REGRESSION (FIX-STRIP-LIVE-3: clicked files never had a strip): two clicked downloads show, one does not', (t) => {
  t.is(deriveDownloadProgress(args([['a', 'downloading', 100], ['b', 'remote', 100]])), null, 'one file has its own row; no strip')
  t.ok(deriveDownloadProgress(args([['a', 'downloading', 100], ['b', 'waiting', 100]])), 'two files under way get the strip')
  t.ok(deriveDownloadProgress(args([['a', 'downloading', 100]], { batchKeys: ['a'] })), 'a one-file batch the user started keeps its strip')
})

test('a batch whose files all finished, beside other downloads, is no longer live', (t) => {
  const p = deriveDownloadProgress(args([['a', 'downloaded', 100], ['x', 'downloading', 100], ['y', 'waiting', 100]], { batchKeys: ['a'] }))
  t.is(p.batchLive, false, 'the batch can be retired')
  t.is(p.files, 3, 'while it is still recorded, its done file counts')
})
