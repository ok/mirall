// SPDX-License-Identifier: AGPL-3.0-only

// One running fetch as counts, for whoever records what the engine is doing: how much is still
// needed and in flight, which holder owes how many chunks, and how far the receive side's stash and
// in-order hash have kept up. `key` is the destination path and `holders` carries peer objects, so
// the caller maps both to its own numbering before anything is written down.

/**
 * @param {import('./scheduler.js').ChunkScheduler} sched
 * @param {{ memBytes: number, received: Set<number>, hashFrontier: number, stats: { readbacks: number, stashHits: number, writeMs: number, hashMs: number } } | null} receive
 */
export function fetchStats(sched, receive) {
  return {
    key: sched.destPath,
    needed: sched._needed.size,
    inflight: sched._inflight.size,
    pacing: sched._pacing,
    rxBytes: sched._receivedBytes,
    totalBytes: sched._totalBytes,
    holders: [...sched._peerInflight],
    stashBytes: receive ? receive.memBytes : 0,
    hashLag: receive ? Math.max(0, receive.received.size - receive.hashFrontier) : 0,
    readbacks: receive ? receive.stats.readbacks : 0,
    stashHits: receive ? receive.stats.stashHits : 0,
    writeMs: receive ? receive.stats.writeMs : 0,
    hashMs: receive ? receive.stats.hashMs : 0,
  }
}
