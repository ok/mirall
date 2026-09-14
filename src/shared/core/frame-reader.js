// The byte half of the NDJSON pipe: bytes in, complete frames out. It knows nothing about what a
// frame means — the bootstrap short-circuit, the cancel branch, the pre-start queue and dispatch all
// live with the router that calls it. A reader lives in its router's closure and dies with it, so
// there is no reset().

const NEWLINE = 0x0A
const EMPTY = Buffer.alloc(0)

// `onOversized(bytes)` fires for every frame refused on size, on both paths: an unterminated buffer
// that passed the cap with no newline in sight, and a terminated frame measured in the loop. The
// caller decides what a refusal costs.
export function createFrameReader({ maxFrameBytes, onOversized }) {
  let buffer = EMPTY
  // After an oversized frame the bytes still arriving belong to the frame being discarded. Without
  // this, the TAIL of that frame is parsed as though it were a fresh one — turning one oversized
  // frame into one forged frame, which is worse than the unbounded buffer it replaces.
  let skipping = false

  return {
    // Bytes, not text: split on the newline BYTE, which cannot occur inside a multi-byte UTF-8
    // sequence, so every complete line is complete UTF-8. Also the only portable answer — Bare has
    // no TextDecoder, and its apparent `string_decoder` is a devDependency artefact absent from a
    // production install.
    push(chunk) {
      // `owned` tracks whether `buffer` is memory of ours or still the caller's chunk, which the
      // pipe is free to reuse once this call returns. Only an owned buffer may be held across ticks
      // as-is; copying one that Buffer.concat already allocated is a second full memcpy per chunk,
      // for every partial frame.
      let owned = buffer.length !== 0
      buffer = owned ? Buffer.concat([buffer, chunk]) : chunk

      if (skipping) {
        const nl = buffer.indexOf(NEWLINE)
        if (nl === -1) { buffer = EMPTY; return [] }
        buffer = Buffer.from(buffer.subarray(nl + 1))
        owned = true
        skipping = false
      }

      // A frame with no terminator in sight cannot be waited out: refused here, before it is ever
      // materialised as a string and before the read buffer can grow without bound. Every TERMINATED
      // frame is measured individually in the loop below — the cap is per frame, not per read
      // buffer, which legitimately carries many small frames at once. Measured in BYTES; nothing on
      // the write side measures, so this cap is enforced here alone.
      if (buffer.length > maxFrameBytes && buffer.indexOf(NEWLINE) === -1) {
        onOversized(buffer.length)
        buffer = EMPTY
        skipping = true
        return []
      }

      // The leftover is committed BEFORE the caller sees a frame, so a handler that throws cannot
      // cause the frames after it to be re-read from a stale buffer.
      const lastNl = buffer.lastIndexOf(NEWLINE)
      if (lastNl === -1) { buffer = owned ? buffer : Buffer.from(buffer); return [] }
      const complete = buffer
      buffer = lastNl + 1 === complete.length ? EMPTY : Buffer.from(complete.subarray(lastNl + 1))

      const frames = []
      let start = 0
      while (start <= lastNl) {
        const nl = complete.indexOf(NEWLINE, start)
        const line = complete.subarray(start, nl)
        start = nl + 1
        if (line.length === 0) continue
        // The cap, measured on the frame itself, so refusal cannot depend on where a chunk boundary
        // fell.
        if (line.length > maxFrameBytes) { onOversized(line.length); continue }
        frames.push(line.toString('utf8'))
      }
      return frames
    },

    // The memory bound this reader promises: the bytes it holds across chunks. A bound is not
    // visible in the frames out, so it is read directly.
    get bufferedBytes() { return buffer.length },
  }
}
