import test from 'brittle'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { listPeerShareMeta } from '../../src/shared/shares/share-catalog.js'

const shareId = 's1'

async function seed (peer, n) {
  for (let i = 0; i < n; i++) {
    await peer.bee.put('file/' + shareId + '/f' + String(i).padStart(4, '0'), { size: i, mtime: i, contentHash: 'h' + i })
  }
}

// REGRESSION (FIX-132: the display read returned [] on a head-update timeout and a truncated list
// on a drain timeout, both indistinguishable from a real empty share. listPeerShareMeta now reports
// `complete` so the renderer keeps its last good list on a partial/un-replicated read.)
test('REGRESSION (FIX-132): a fully-replicated peer catalog reads complete; an un-replicated head reads complete:false (not a silent empty)', { timeout: 20000 }, async (t) => {
  await freshPeer(t)

  const B = await makePeer(t)
  await seed(B, 25)
  replicate(getStore(), B.store, t)
  t.ok(await waitFor(async () => (await listPeerShareMeta(B.key, shareId)).entries.length === 25), 'replicates fully')
  const full = await listPeerShareMeta(B.key, shareId)
  t.is(full.complete, true, 'fully-replicated read is complete')
  t.is(full.entries.length, 25, 'all rows present')

  setRuntimeConfig({ ...getRuntimeConfig(), peerReadTimeoutMs: 200 })
  const ghostKey = b4a.toString(crypto.randomBytes(32), 'hex')
  const t0 = Date.now()
  const res = await listPeerShareMeta(ghostKey, shareId)
  t.ok(Date.now() - t0 < 4000, 'bounded by the read budget (' + (Date.now() - t0) + 'ms), not the 30s IPC ceiling')
  t.is(res.complete, false, 'un-replicated head → incomplete (renderer keeps last good)')
  t.alike(res.entries, [], 'no rows from an unreachable catalog')
})

// REGRESSION (FIX-359): FIX-132 covered an empty/un-replicated read. The nastier shape is a drain
// that starts fine and is cut short mid-tree: it returns a PARTIAL, NON-EMPTY list. That read is
// indistinguishable from "the owner deleted the rest" unless `complete` is reported — and the
// mirror's deletion guard used to see only the entry count, so it deleted every file it could not
// see. The partial read must report complete:false while still returning the rows it did drain.
test('REGRESSION (FIX-359): a truncated drain reports complete:false WITH its partial entries', async (t) => {
  await freshPeer(t)
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  const B = await makePeer(t)
  await seed(B, 25)
  replicate(getStore(), B.store, t)
  t.ok(await waitFor(async () => (await listPeerShareMeta(B.key, shareId)).entries.length === 25), 'replicates fully')

  setRuntimeConfig({ ...getRuntimeConfig(), testTruncatePeerDrainAfter: 10 })
  const res = await listPeerShareMeta(B.key, shareId)
  t.is(res.complete, false, 'a cut-short drain is NOT complete — this is the flag the mirror acts on')
  t.is(res.entries.length, 10, 'and it is partial but non-empty: the exact shape that used to authorize deletions')
})
