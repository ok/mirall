import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { getStore } from '../../src/shared/core/store.js'
import { FileIndex } from '../../src/shared/transfer/backends/overlay/vendor/file-index.js'

// Each name's first byte is above the old `'\xff'` (C3 BF) bound.
const NAMES = ['plain.txt', 'ÿ-latin1.txt', 'Łódź.pdf', 'Отчёты.txt', '日本語.txt', '😀.png']

// REGRESSION (FIX-BEEKEY-1: the vendored overlay file index bounded its prefix scans with
// `prefix + '\xff'`. A file whose top-level name starts at U+0100 or above was missing from
// listFiles(), so protocol-v2's content-hash -> disk-path fallback could not resolve it and the
// serve silently dropped the chunk request.)
test('REGRESSION (FIX-BEEKEY-1): the overlay file index lists paths above U+00FF', async (t) => {
  await freshPeer(t)
  const index = new FileIndex(getStore().namespace('overlay-prefix-bound-test'))
  await index.ready()
  t.teardown(() => index.close())

  for (const name of NAMES) {
    await index.putFile(name, { contentHash: 'h'.repeat(64), size: 1, mtime: 1 })
    await index.putSyncState('peer-a', name, { lastSeq: 1, lastHash: 'h'.repeat(64) })
  }

  const files = await index.listFiles()
  t.alike(files.map((f) => f.path).sort(), [...NAMES].sort(), 'listFiles yields every name')

  const states = await index.listSyncStates('peer-a')
  t.alike(states.map((s) => s.path).sort(), [...NAMES].sort(), 'listSyncStates yields every name')
})
