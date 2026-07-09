import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// REGRESSION (FIX-132, flow): a browsing peer's view of a folder the owner is still indexing must
// grow monotonically and converge — never shrink back toward empty. Exercises that the owner's
// batched catalog publish (Phase 2) replicates as a consistent, append-only listing across workers.
test('a browsing peer sees the indexing folder grow monotonically and converge — never shrinks', { timeout: scaled(180000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Big' })
  const folder = mkTmpDir(t)
  const N = 150
  for (let i = 0; i < N; i++) fs.writeFileSync(path.join(folder, 'f' + String(i).padStart(4, '0') + '.txt'), 'x'.repeat(64))

  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })

  let peak = 0
  let monotonic = true
  const deadline = Date.now() + scaled(120000)
  while (Date.now() < deadline) {
    const res = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id }).catch(() => ({ entries: [] }))
    const count = Array.isArray(res?.entries) ? res.entries.length : 0
    if (count < peak) monotonic = false
    peak = Math.max(peak, count)
    if (peak === N) break
    await new Promise((r) => setTimeout(r, scaled(400)))
  }
  t.ok(monotonic, 'the browse listing never shrank during indexing (peak ' + peak + ')')
  t.is(peak, N, 'converges to the full file count')
})
