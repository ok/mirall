import test from 'brittle'
import b4a from 'b4a'
import Hyperbee from 'hyperbee'
import createTestnet from 'hyperdht/testnet.js'
import { setupPeer, teardownPeer, serve, consume, eventually } from './_holepunch.js'

// Invariant the offline-co-member-approval convergence fix relies on (see
// .claude/tasks/plan-offline-member-convergence-fix.md): a co-member (B) that has FULLY
// replicated a joiner's (C) profile core while C was online will serve that core
// TRANSITIVELY to the owner (A) — over the existing A↔B Corestore connection, without A
// ever connecting to C and after C goes offline. The fix's whole job is to guarantee a
// co-member holds C's record; this proves that once one does, the owner converges.

const SPACE = 'space-abc'
const CAP = 'caps/membership-manifest'

function openByKey (store, keyBuf) {
  return new Hyperbee(store.get(keyBuf), { keyEncoding: 'utf-8', valueEncoding: 'json' })
}

test('a co-member serves an offline joiner\'s membership record transitively to the owner', async (t) => {
  const testnet = await createTestnet(3, { teardown: t.teardown })
  const C = await setupPeer(testnet, 'C-joiner')
  const B = await setupPeer(testnet, 'B-comember')
  const A = await setupPeer(testnet, 'A-owner')
  t.teardown(() => teardownPeer(B))
  t.teardown(() => teardownPeer(A))

  // C authors its OWN membership record (what the OR-Set fold rule (1) requires from C).
  const cBee = new Hyperbee(C.store.get({ name: 'profile' }), { keyEncoding: 'utf-8', valueEncoding: 'json' })
  await cBee.ready()
  await cBee.put(CAP, true)
  await cBee.put('member/' + SPACE, { active: true, ts: 1 })
  const cKey = b4a.from(cBee.core.key)
  const cLen = cBee.core.length

  // B fully replicates C's core while C is online (this is what the fix guarantees at approval).
  await serve(C, cBee.core.discoveryKey)
  const cOnB = openByKey(B.store, cKey)
  await cOnB.ready()
  consume(B, cOnB.core.discoveryKey)
  await cOnB.core.update({ wait: true })
  cOnB.core.download({ start: 0, end: -1 })
  t.ok(await eventually(async () => (cOnB.core.contiguousLength >= cLen ? true : null)),
    'precondition: B fully replicated C\'s core')

  // C goes OFFLINE — only B now holds C's blocks.
  await teardownPeer(C)

  // A connects to B over a shared relay topic (NOT C's topic) — the A↔B connection a space
  // provides — and opens C's core by key. It must pull C transitively from B.
  const relay = b4a.alloc(32, 7)
  B.swarm.join(relay, { server: true, client: true })
  await B.swarm.flush()
  const cOnA = openByKey(A.store, cKey)
  await cOnA.ready()
  consume(A, relay)
  await cOnA.core.update({ wait: true })
  cOnA.core.download({ start: 0, end: -1 })

  t.ok(await eventually(async () => (cOnA.core.contiguousLength >= cLen ? true : null)),
    'owner pulled the offline joiner\'s core transitively via the co-member')
  const member = await cOnA.get('member/' + SPACE)
  t.alike(member?.value, { active: true, ts: 1 }, 'owner reads the joiner\'s member record')
})
