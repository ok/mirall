import test from 'brittle'
import { OverlayProtocolV2 } from '../../src/shared/transfer/backends/overlay/vendor/protocol-v2.js'

// REGRESSION (FIX-3: a peer that left the space kept serving it). The serve grant is cached per
// (peer, syntheticPath) at request time and every later chunkNeed is checked against that cache
// alone — so leaving a space, or revoking a member, has to invalidate it ACTIVELY. These cover
// the two mechanisms that do: revokeServes (we know what to stop) and the serve epoch (the gate
// re-decides). Both live in the vendored protocol, so they also guard the mirall patch itself.

// A peer as the protocol holds it: the grant map is the whole surface these paths touch.
function fakePeer (name) {
  return { name, authorizedServe: new Map() }
}

// The sync engine + transfer manager are untouched by the grant paths under test.
function protocolWith (peers, { authorize = async () => true } = {}) {
  const proto = new OverlayProtocolV2(null, null, { serveAuthorizer: authorize })
  for (const p of peers) proto._peers.set({ mux: p.name }, p)
  return proto
}

const grant = (peer, hash, from) => peer.authorizedServe.set('content:' + hash, { from, epoch: 0 })

test('revokeServes drops only the grants the predicate selects, and fires serve-end once each', (t) => {
  const alice = fakePeer('alice')
  const bob = fakePeer('bob')
  grant(alice, 'h-left', 'alice-key')
  grant(alice, 'h-kept', 'alice-key')
  grant(bob, 'h-left', 'bob-key')
  grant(bob, 'h-kept', 'bob-key')

  const ended = []
  const proto = protocolWith([alice, bob])
  proto._serveEndCb = (info) => ended.push(info)

  const revoked = proto.revokeServes(({ contentHash }) => contentHash === 'h-left')

  t.is(revoked, 2, 'both peers lose the grant for the left space')
  t.absent(alice.authorizedServe.has('content:h-left'), 'alice no longer serves the left space')
  t.absent(bob.authorizedServe.has('content:h-left'), 'bob no longer serves the left space')
  t.ok(alice.authorizedServe.has('content:h-kept'), 'a grant for a space we still share survives')
  t.ok(bob.authorizedServe.has('content:h-kept'), 'the other peer keeps its surviving grant too')

  t.is(ended.length, 2, 'serve-end fired once per revoked grant')
  t.is(ended[0].path, 'content:h-left', 'serve-end carries the synthetic path')
  t.is(ended[0].from, 'alice-key', 'serve-end still carries the requester identity (the { from, epoch } grant shape)')
})

test('a peer-scoped revoke stops the leaver without cutting off co-members of the same space', (t) => {
  // A remote leave revokes only the LEAVER's grants. A space-wide revoke here would also drop the
  // grants of every other member still legitimately downloading that space's files from us.
  const leaver = fakePeer('leaver')
  const stayer = fakePeer('stayer')
  grant(leaver, 'h-shared', 'leaver-key')
  grant(stayer, 'h-shared', 'stayer-key')   // same file, same space, a member who did NOT leave
  const proto = protocolWith([leaver, stayer])

  const revoked = proto.revokeServes(({ contentHash, from }) => contentHash === 'h-shared' && from === 'leaver-key')

  t.is(revoked, 1, 'only the leaver\'s grant is revoked')
  t.absent(leaver.authorizedServe.has('content:h-shared'), 'the leaver stops receiving the space\'s bytes')
  t.ok(stayer.authorizedServe.has('content:h-shared'), 'a co-member\'s in-flight download is untouched')
})

test('revokeServes: a predicate matching nothing revokes nothing', (t) => {
  const alice = fakePeer('alice')
  grant(alice, 'h1', 'alice-key')
  const proto = protocolWith([alice])
  t.is(proto.revokeServes(() => false), 0, 'no grant dropped')
  t.ok(alice.authorizedServe.has('content:h1'), 'the grant survives')
})

test('a cached grant is trusted until the epoch moves — then it re-authorizes exactly once', async (t) => {
  const alice = fakePeer('alice')
  let calls = 0
  const proto = protocolWith([alice], { authorize: async () => { calls++; return true } })
  grant(alice, 'h1', 'alice-key')

  t.ok(await proto._serveStillAuthorized(alice, 'content:h1'), 'the fresh grant serves')
  t.is(calls, 0, 'no re-authorization while the epoch is unchanged — the hot path stays a map lookup')

  proto.bumpServeEpoch()
  t.ok(await proto._serveStillAuthorized(alice, 'content:h1'), 'a still-entitled peer keeps serving after the bump')
  t.is(calls, 1, 're-authorized once for the new epoch')

  t.ok(await proto._serveStillAuthorized(alice, 'content:h1'), 'the refreshed grant serves')
  t.is(calls, 1, 'and is not re-checked again within the same epoch (bounded to one check per epoch)')
})

test('REGRESSION (FIX-3): an epoch bump revokes a grant the gate no longer approves', async (t) => {
  const evicted = fakePeer('evicted')
  let approved = true
  const ended = []
  const proto = protocolWith([evicted], { authorize: async () => approved })
  proto._serveEndCb = (info) => ended.push(info)
  grant(evicted, 'h1', 'evicted-key')

  t.ok(await proto._serveStillAuthorized(evicted, 'content:h1'), 'serving while approved')

  approved = false          // membership revoked mid-transfer
  proto.bumpServeEpoch()

  t.absent(await proto._serveStillAuthorized(evicted, 'content:h1'),
    'the ex-member stops being served — the cached grant does not outlive its membership')
  t.absent(evicted.authorizedServe.has('content:h1'), 'the stale grant is dropped, not just refused')
  t.is(ended.length, 1, 'serve-end fired so the sender-side indicator clears')
})

test('re-authorization does not charge the requester rate limit', async (t) => {
  // The limiter bounds inbound content-REQUESTS. A re-validation is ours, not the peer's: charging
  // it would revoke healthy transfers for being numerous the moment the epoch moves.
  const alice = fakePeer('alice')
  const seen = []
  const proto = protocolWith([alice], { authorize: async (peer, from, hash, opts) => { seen.push(opts); return true } })
  grant(alice, 'h1', 'alice-key')

  proto.bumpServeEpoch()
  await proto._serveStillAuthorized(alice, 'content:h1')

  t.is(seen.length, 1, 're-authorized once')
  t.is(seen[0]?.rateLimit, false, 'the re-check opts out of the serve rate limit')
})

test('a grant revoked across the re-authorization await is not resurrected', async (t) => {
  const alice = fakePeer('alice')
  const proto = protocolWith([alice], {
    // Revoke mid-flight, exactly as a concurrent space:leave would.
    authorize: async () => { alice.authorizedServe.delete('content:h1'); return true },
  })
  grant(alice, 'h1', 'alice-key')
  proto.bumpServeEpoch()

  t.absent(await proto._serveStillAuthorized(alice, 'content:h1'),
    'the concurrent revocation wins — a stale approval cannot re-grant a dropped serve')
})
