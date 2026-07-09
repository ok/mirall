import test from 'brittle'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createBee } from '../../src/shared/core/store.js'
import { fileKey, getPeerEntryState, getPeerEntry } from '../../src/shared/shares/share-catalog.js'
import { isRepublished } from '../../src/shared/transfer/supersede-decision.js'

// The seq the remove+re-add teardown (FIX-REMOVE-1) keys on: a Hyperbee re-write of a key lands
// a HIGHER node.seq — even for identical content — replicated identically across peers, while a
// different key's write leaves ours unchanged. That is what lets a receiver spot a re-publish it
// never observed as a tombstone. This pins the mechanism against a real catalog bee.
test('catalog entry seq bumps on re-write, is stable across other keys, and surfaces through the readers', async (t) => {
  await freshPeer(t)
  const bee = createBee('seq-catalog-test')
  await bee.ready()
  const keyHex = b4a.toString(bee.core.key, 'hex')
  const K = fileKey('__loose__', 'x.bin')
  const HASH = 'a'.repeat(64)

  await bee.put(K, { size: 10, mtime: 1, contentHash: HASH })
  const s1 = await getPeerEntryState(keyHex, '__loose__', 'x.bin')
  t.is(s1.removed, false)
  t.ok(Number.isInteger(s1.seq), 'advertise surfaces a seq')

  await bee.put(K, { size: 10, mtime: 1, contentHash: HASH, deletedAt: 1 }) // tombstone
  const sTomb = await getPeerEntryState(keyHex, '__loose__', 'x.bin')
  t.is(sTomb.removed, true, 'tombstone reads as removed')

  await bee.put(K, { size: 10, mtime: 2, contentHash: HASH }) // re-add, IDENTICAL content
  const s2 = await getPeerEntryState(keyHex, '__loose__', 'x.bin')
  t.is(s2.removed, false)
  t.ok(s2.seq > s1.seq, 're-add (even identical content) lands a higher seq')
  t.ok(isRepublished(s2.seq, s1.seq), 'the receiver detects the re-publish via seq')

  await bee.put(fileKey('__loose__', 'other.bin'), { size: 1, mtime: 1, contentHash: 'b'.repeat(64) })
  const s3 = await getPeerEntryState(keyHex, '__loose__', 'x.bin')
  t.is(s3.seq, s2.seq, "a different key's write leaves our entry's seq unchanged (no false re-publish)")
  t.absent(isRepublished(s3.seq, s2.seq), 'no re-publish detected from an unrelated write')

  const legacy = await getPeerEntry(keyHex, '__loose__', 'x.bin')
  t.is(legacy.seq, s2.seq, 'getPeerEntry also carries seq')
})
