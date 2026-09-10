import test from 'brittle'
import { freshPeer } from '../helpers/store.js'
import { makePeer, replicate, waitFor } from '../helpers/peer-bee.js'
import { getStore } from '../../src/shared/core/store.js'
import { createSpace } from '../../src/shared/spaces/space.js'
import { advertise, collectOwnShare, listPeerShareMeta } from '../../src/shared/shares/share-catalog.js'
import { markVerified, markDownloaded, listVerifiedForShare, listDownloadClaimsForShare } from '../../src/shared/transfer/files.js'

const shareId = 's1'

// Each of these has a first byte above the old `'\xff'` (C3 BF) bound: ł is C5 82, О is D0 9E,
// 日 is E6 97 A5, 😀 is F0 9F 98 80. A plain ASCII name and a U+00FF one pin that the fix does
// not lose what already worked.
const NAMES = ['plain.txt', 'ÿ-latin1.txt', 'Łódź.pdf', 'Отчёты.txt', '日本語.txt', '😀.png']

// REGRESSION (FIX-BEEKEY-1: every catalog and download-history range scan bounded its prefix with
// `prefix + '\xff'`. Under `keyEncoding: 'utf-8'` that is U+00FF, so a top-level file whose name
// starts at U+0100 or above sorted ABOVE the bound: it was invisible in the owner's own listing
// AND in every peer's listing, and the owner re-diffed it on every reconcile.)
test('REGRESSION (FIX-BEEKEY-1): a share lists top-level names above U+00FF, own and peer', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  for (const name of NAMES) await advertise(space.spaceId, shareId, name, { size: 1, mtime: 1 })

  const own = await collectOwnShare(space.spaceId, shareId)
  t.is(own.total, NAMES.length, 'own listing counts every name')
  t.alike(own.entries.map((e) => e.relPath).sort(), [...NAMES].sort(), 'own listing yields every name')

  // The same keys read back through a peer's replicated catalog — the path that decides what
  // other members can see and download.
  const B = await makePeer(t)
  for (const name of NAMES) await B.bee.put('file/' + shareId + '/' + name, { size: 1, mtime: 1, contentHash: 'h' })
  replicate(getStore(), B.store, t)
  t.ok(await waitFor(async () => (await listPeerShareMeta(B.key, shareId)).entries.length === NAMES.length), 'peer catalog replicates every name')

  const peer = await listPeerShareMeta(B.key, shareId)
  t.alike(peer.entries.map((e) => e.relPath).sort(), [...NAMES].sort(), 'peer listing yields every name')
})

// The download history is keyed by the same user-controlled text, and its two bulk scans feed the
// per-row "downloaded" state and the mirror's on-device byte total.
test('REGRESSION (FIX-BEEKEY-1): the download-history bulk scans see names above U+00FF', async (t) => {
  await freshPeer(t)
  const space = await createSpace('Aurora')
  const shareName = 'Проект'

  for (const name of NAMES) {
    await markVerified(space.spaceId, shareId + '|' + name, 'h'.repeat(64))
    await markDownloaded(space.spaceId, '/' + shareName + '/' + name, '/tmp/' + name, { hash: 'h'.repeat(64) })
  }

  const verified = await listVerifiedForShare(space.spaceId, shareId)
  t.is(verified.size, NAMES.length, 'verified-hash scan sees every name')

  const claims = await listDownloadClaimsForShare(space.spaceId, shareName)
  t.is(claims.size, NAMES.length, 'download-claim scan sees every name under a non-ASCII share name')
})
