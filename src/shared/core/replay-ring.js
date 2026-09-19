// The recent durable event frames, so a client that was away can be caught up instead of told to
// start over. Bounded twice — by count and by bytes — because a count is not a memory bound when
// frames vary by three orders of magnitude.
//
// `floor` is the seq of the newest frame ever evicted. A cursor at or above it has missed nothing
// the ring cannot supply; one below it has, and the only honest answer is "gap".
export function createReplayRing({ maxFrames = 512, maxBytes = 1024 * 1024 } = {}) {
  const frames = []
  let bytes = 0
  let floor = 0

  // UTF-16 code units, not bytes: an under-count for non-ASCII payloads, bounded at ~3x. This is a
  // soft memory cap, and a Buffer.byteLength per frame on the emit path is not worth exactness.
  const sizeOf = (line) => line.length

  function evict() {
    const dropped = frames.shift()
    bytes -= sizeOf(dropped.line)
    floor = dropped.seq
  }

  return {
    push(seq, line) {
      // A single frame larger than the whole cap is not retained, and counts as evicted: a client
      // resuming across it has genuinely missed something and must resync rather than be told it
      // missed nothing. Everything older goes with it — the floor now sits above those frames, so
      // they could never be returned again, and holding them would only spend the budget.
      if (sizeOf(line) > maxBytes) {
        frames.length = 0
        bytes = 0
        floor = seq
        return
      }
      frames.push({ seq, line })
      bytes += sizeOf(line)
      while (frames.length > maxFrames || bytes > maxBytes) evict()
    },

    // Lines after the cursor, oldest first — or null when the cursor predates what the ring still
    // holds, which is the caller's signal to resync rather than replay.
    since(cursor) {
      if (cursor < floor) return null
      return frames.filter((f) => f.seq > cursor).map((f) => f.line)
    },

    /** @internal */
    stats: () => ({ frames: frames.length, bytes, floor }),
  }
}
