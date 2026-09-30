import test from 'brittle'
import { planRound, refundChunks } from '../../src/shared/transfer/backends/overlay/engine/scheduler/assign.js'

function state({ peers, lengths, cap = 8, limiter = null, cursor = 0 }) {
  return {
    peers: new Set(peers),
    cursor,
    cap,
    peerInflight: new Map(peers.map((p) => [p, 0])),
    needed: new Set(lengths.map((_, i) => i)),
    inflight: new Map(),
    chunks: lengths.map((length, i) => ({ hash: 'h' + i, offset: 0, length })),
    limiter,
  }
}

// A cap that grants a fixed byte budget per round.
function budget(bytes, { wouldBlock } = {}) {
  let left = bytes
  const limiter = {
    takes: 0,
    tryTake(n) { limiter.takes++; if (n > left) return false; left -= n; return true },
    isUnlimited: () => false,
    give() {},
  }
  if (wouldBlock) limiter.wouldBlock = wouldBlock
  return limiter
}

test('the starting holder rotates, so every holder is reached under a tight cap', (t) => {
  const reached = new Set()
  let cursor = 0
  for (let round = 0; round < 3; round++) {
    const s = state({ peers: ['a', 'b', 'c'], lengths: [10, 10, 10, 10], limiter: budget(10), cursor })
    const res = planRound(s)
    cursor = res.cursor
    for (const [peer, indices] of res.batches) if (indices.length) reached.add(peer)
  }
  t.alike([...reached].sort(), ['a', 'b', 'c'])
})

test('an unaffordable head chunk does not block a smaller one behind it', (t) => {
  const res = planRound(state({ peers: ['a'], lengths: [100, 10], limiter: budget(10) }))
  t.alike(res.batches.get('a'), [1])
  t.ok(res.gated)
  t.is(res.gatedBytes, 100)
})

test('a structural block ends the round at once', (t) => {
  const limiter = budget(0, { wouldBlock: () => true })
  const res = planRound(state({ peers: ['a', 'b'], lengths: [10, 10, 10], limiter }))
  t.is(limiter.takes, 1, 'one refusal, no scan and no second holder')
  t.is(res.batches.size, 0)
  t.ok(res.gated)
})

test('without wouldBlock the scan stops after 32 refusals', (t) => {
  const limiter = budget(0)
  planRound(state({ peers: ['a'], lengths: new Array(100).fill(10), limiter }))
  t.is(limiter.takes, 32)
})

test('assigned chunks are recorded in flight, one holder each', (t) => {
  const s = state({ peers: ['a', 'b'], lengths: [1, 1, 1, 1, 1], cap: 2 })
  const res = planRound(s)
  t.is(s.inflight.size, 4, 'two slots per holder')
  t.is(s.peerInflight.get('a'), 2)
  t.is(s.peerInflight.get('b'), 2)
  const assigned = [...res.batches.values()].flat().sort()
  t.alike(assigned, [0, 1, 2, 3])
  t.absent(res.gated)
})

test('refundChunks returns the abandoned bytes as one sum', (t) => {
  const gives = []
  const limiter = { isUnlimited: () => false, give: (n) => gives.push(n) }
  const chunks = [{ length: 3 }, { length: 5 }, { length: 7 }]
  refundChunks(limiter, chunks, [0, 2])
  t.alike(gives, [10])
  refundChunks(limiter, chunks, [])
  t.alike(gives, [10], 'nothing to refund gives nothing')
})

test('refundChunks is a no-op for an unlimited or absent limiter', (t) => {
  const gives = []
  refundChunks({ isUnlimited: () => true, give: (n) => gives.push(n) }, [{ length: 3 }], [0])
  refundChunks(null, [{ length: 3 }], [0])
  t.alike(gives, [])
})
