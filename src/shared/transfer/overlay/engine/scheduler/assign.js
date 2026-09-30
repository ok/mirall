// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/chunk-scheduler.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// One assignment round: hand needed-but-not-inflight chunks to holders with spare slots. A pull
// protocol paces its inbound bytes by pacing its requests, so the download cap is charged here
// rather than on arrival (by then the bytes are spent).

// How far a round scans past chunks the cap cannot currently afford before giving up on it.
const GATED_SCAN_LIMIT = 32

// Mutates `inflight` and `peerInflight` for every chunk it assigns, and charges the limiter
// through tryTake. Returns each holder's batch, the next rotation cursor, and whether the cap held
// the round back (with the smallest chunk it refused).
//
// The starting holder rotates: under a cap a round's budget is a chunk or two, so a fixed first
// holder would take all of it and multi-source fetch would become single-source. A single holder
// is the common case and allocates no rotation array.
export function planRound(s) {
  const peerCount = s.peers.size
  const list = peerCount > 1 ? [...s.peers] : null
  const cursor = list ? (s.cursor + 1) % peerCount : s.cursor
  const round = { batches: new Map(), cursor, gated: false, gatedBytes: 0, probes: 0, blocked: false }
  const single = list ? null : s.peers.values().next().value
  // Only a structural block ends the round: a holder gated on size alone does not, or the first
  // holder in order would be gated before it filled and the others would never be reached.
  for (let n = 0; n < peerCount && !round.blocked; n++) fillPeer(s, list ? list[(cursor + n) % peerCount] : single, round)
  return round
}

function fillPeer(s, peer, round) {
  let slots = s.cap - (s.peerInflight.get(peer) || 0)
  for (const index of s.needed) {
    if (slots <= 0) return
    if (s.inflight.has(index)) continue
    if (s.limiter && !charge(s, index, round)) {
      if (round.blocked || round.probes >= GATED_SCAN_LIMIT) return
      continue
    }
    s.inflight.set(index, peer)
    s.peerInflight.set(peer, (s.peerInflight.get(peer) || 0) + 1)
    if (!round.batches.has(peer)) round.batches.set(peer, [])
    round.batches.get(peer).push(index)
    slots--
  }
}

// Chunk sizes vary 4x within a tier, so an unaffordable chunk must not block a smaller one behind
// it and the scan goes on. `wouldBlock` ends it at once when the refusal is structural (nothing of
// any size can be taken this round); an embedder's limiter may lack it, and then only
// GATED_SCAN_LIMIT bounds the scan.
function charge(s, index, round) {
  const len = s.chunks[index].length
  if (s.limiter.tryTake(len)) return true
  round.gatedBytes = round.gated ? Math.min(round.gatedBytes, len) : len
  round.gated = true
  if (typeof s.limiter.wouldBlock === 'function' && s.limiter.wouldBlock()) round.blocked = true
  else round.probes++
  return false
}

// Return abandoned chunks' bytes to the limiter as one sum. `give` clamps the bucket, and
// min(c, min(c, t+a)+b) equals min(c, t+a+b), so one call credits exactly what N calls would.
export function refundChunks(limiter, chunks, indices) {
  if (!limiter || limiter.isUnlimited()) return
  let total = 0
  for (const index of indices) {
    const len = chunks?.[index]?.length
    if (len > 0) total += len
  }
  if (total > 0) limiter.give(total)
}
