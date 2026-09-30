// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/protocol-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// Chunk-list paging on both sides of the wire. A list is paged so no frame exceeds the Noise
// transport's 16 MiB-1 atomic write (@hyperswarm/secret-stream MAX_ATOMIC_WRITE): an entry is at
// most 37 bytes on the wire, so a page stays under 4 MB even after protomux batches sends of up to
// 8 MiB. A list that fits in one frame ships as one.
export const MAX_CHUNKS_PER_MSG = 100000

// What one peer may hold in half-paged maps. Entries are summed across its maps: 2^21 is a 2 TiB
// file at the tier-3 average chunk, ~270 MB decoded. Only a map over MAX_CHUNKS_PER_MSG entries
// pages at all, and a peer buffers only for fetches that asked it, so the map count is headroom
// over the download concurrency.
export const MAX_PAGED_ENTRIES_PER_PEER = 2 ** 21
export const MAX_PAGED_MAPS_PER_PEER = 16

export function sendChunkHashes(peer, path, tier, chunks) {
  const total = chunks.length
  if (total <= MAX_CHUNKS_PER_MSG) {
    peer.msgs.chunkHashes.send({ path, tier, chunks, more: 0 })
    return
  }
  for (let i = 0; i < total; i += MAX_CHUNKS_PER_MSG) {
    const more = i + MAX_CHUNKS_PER_MSG < total ? 1 : 0
    peer.msgs.chunkHashes.send({ path, tier, chunks: chunks.slice(i, i + MAX_CHUNKS_PER_MSG), more })
  }
}

// The receiving side: each peer's partial pages, per path. Pages for a path arrive in order on
// one channel, so arrival-order concatenation is correct even when several files interleave.
export function createChunkHashAssembler() {
  const byPeer = new WeakMap()

  return {
    // Which bound buffering this page would break: 'map' past `mapBound()` entries (the fetch's
    // size-derived ceiling, or null for none), 'peer' past the peer's own budget, else null.
    overflow(peer, msg, mapBound) {
      const pages = byPeer.get(peer)
      const buffered = pages?.get(msg.path)
      if (!buffered && !msg.more) return null
      const bound = mapBound()
      if (bound !== null && (buffered ? buffered.length : 0) + msg.chunks.length > bound) return 'map'
      if (!pages) return msg.chunks.length > MAX_PAGED_ENTRIES_PER_PEER ? 'peer' : null
      if (!buffered && pages.size >= MAX_PAGED_MAPS_PER_PEER) return 'peer'
      let held = msg.chunks.length
      for (const acc of pages.values()) held += acc.length
      return held > MAX_PAGED_ENTRIES_PER_PEER ? 'peer' : null
    },

    // The full list once its last page arrives, or null while pages are pending. A lone
    // complete frame passes straight through without a copy.
    take(peer, msg) {
      let pages = byPeer.get(peer)
      const buffered = pages?.get(msg.path)
      if (!buffered && !msg.more) return msg.chunks
      if (!pages) { pages = new Map(); byPeer.set(peer, pages) }
      let acc = buffered
      if (!acc) { acc = []; pages.set(msg.path, acc) }
      for (const ch of msg.chunks) acc.push(ch)
      if (msg.more) return null
      pages.delete(msg.path)
      return acc
    },

    drop(peer, path) { byPeer.get(peer)?.delete(path) },
    forget(peer) { byPeer.delete(peer) },
    /** @internal */
    has(peer, path) { return byPeer.get(peer)?.has(path) ?? false },
  }
}
