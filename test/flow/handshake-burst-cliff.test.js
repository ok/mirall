import test from 'brittle'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled, unscaled } from '../helpers/timing.js'

// REGRESSION (FIX-HANDSHAKE-BURST: the receiver's matched identity-frame lane had a fixed
// burst of 8 and banned after 24 consecutive drops. A reconnect puts N + min(N, 8)
// back-to-back frames on each side's lane — the opening burst plus reciprocals — so two
// peers sharing 24 spaces evicted each other's Noise key for the process lifetime, and
// below that, spaces 9+ waited 10-25 s for the announce ledger. Joining spaces in a row
// stalled every fifth join the same way. The lane's burst now scales with the topics the
// receiver joined, so the whole exchange lands in one round trip.)
//
// Deadlines are ABSOLUTE (unscaled / raw ms): every failure mode here races an unscaled
// production constant — the ledger's 10 s base on a 15 s tick, or a ban that never heals —
// so a scaled deadline on a slow runner would pass through the very retry path the fix
// removes. launchPeer's relaunch also re-sends every handshake once more (profile:set ->
// broadcastProfileUpdate), which makes the exchange 2N + 8 frames — still under the cap.
const N = 24

test('REGRESSION (FIX-HANDSHAKE-BURST): peers sharing 24 spaces reconnect in one round trip, unbanned', { timeout: scaled(300000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const aStore = path.join(mkTmpDir(t), 'app-storage')
  const aDownloads = mkTmpDir(t)
  let A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: aDownloads })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const aKey = (await A.request('profile:get')).publicKey
  const bKey = (await B.request('profile:get')).publicKey

  // Joining N spaces back-to-back costs the creator's lane 2 frames per space; the fixed
  // burst dropped the fifth join's frame and it waited 10-25 s for the ledger. Bound each
  // join absolutely: a healthy join is ~30 ms and a stalled one is >= 10 s (the ledger's
  // unscaled base), so 9 s sits two orders of magnitude above the pass case and below the
  // failure case. connectInSpace polls at 1 s, so this tolerates eight missed polls before it
  // could report runner load rather than a stall — if it ever fails alone on a loaded shard,
  // that is the flake, and the bound must not be SCALED (a scaled deadline would pass through
  // the very ledger retry this test exists to catch).
  const spaceIds = []
  let slowestJoinMs = 0
  for (let i = 0; i < N; i++) {
    const started = Date.now()
    spaceIds.push(await connectInSpace(t, A, B, 'Space ' + i))
    slowestJoinMs = Math.max(slowestJoinMs, Date.now() - started)
  }
  t.ok(slowestJoinMs < 9000, `slowest of ${N} back-to-back joins took ${slowestJoinMs}ms — no ledger stall`)

  // A goes away and comes back with the same identity and drives: both sides fire a fresh
  // opening burst for all N spaces on the new socket. Keep the pre-kill stderr: reassigning A
  // below drops the original handle, and the join loop above is one of the two bursts that
  // could have evicted.
  const stderrBeforeRelaunch = A.readStderr()
  A.kill()
  await B.until('members:online', { spaceId: spaceIds[0] }, (o) => !o.includes(aKey), { ms: 90000 })
  const relaunchedAt = Date.now()
  A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: aStore, downloads: aDownloads })

  // Presence is leased on handshake admission, so members:online is the end-state signal
  // for "this side admitted the peer's frame for this space" — no reliance on catching an
  // event that may fire before the listener is attached.
  for (const spaceId of spaceIds) {
    await A.until('members:online', { spaceId }, (o) => o.includes(bKey), { ms: unscaled(9000) })
  }
  t.pass(`A re-admitted B in all ${N} spaces ${Date.now() - relaunchedAt}ms after relaunch`)
  for (const spaceId of spaceIds) {
    await B.until('members:online', { spaceId }, (o) => o.includes(aKey), { ms: unscaled(9000) })
  }
  t.pass(`B re-admitted A in all ${N} spaces`)
  t.absent(/evicting flooding peer/.test(stderrBeforeRelaunch + A.readStderr() + B.readStderr()), 'neither side evicted the other, in either burst')
})
