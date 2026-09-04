'use strict'

// Worker→main control frames ('main-request', e.g. start-watcher) are tiny — a command plus a
// few path args. Anything larger on the shared worker pipe is a worker→renderer response (e.g. a
// big file listing) that main has already broadcast and must NOT JSON.parse on its UI thread.
// This gate is what keeps a multi-MB response frame off main's main thread.
const MAIN_REQUEST_MAX_LINE = 64 * 1024

const NEWLINE = 0x0A
const EMPTY = Buffer.alloc(0)

// True only for a non-empty frame small enough to plausibly be a control frame. Production passes
// a Buffer (the reader below gates before decoding), so `.length` is BYTES — the same number the
// worker computed with Buffer.byteLength when it wrote the frame. A string is still accepted, and
// there `.length` is UTF-16 code units, which is looser.
function isControlFrameCandidate (line) {
  return line.length > 0 && line.length <= MAIN_REQUEST_MAX_LINE
}

// Frames are split on the newline BYTE, and only a complete frame is ever decoded. 0x0A cannot
// occur inside a multi-byte UTF-8 sequence (continuation bytes are 0x80–0xBF, lead bytes >= 0xC2),
// so a byte split is exact — whereas `buffer += chunk.toString()` is not: a chunk ending mid-
// sequence decodes the split character to U+FFFD on BOTH halves, U+FFFD is legal JSON, so
// JSON.parse succeeds and main acts on a corrupted string. An owned folder named 'Müller Projekte'
// had its watcher armed on a path that does not exist, and chokidar reports nothing for a missing
// path — so the folder silently stopped re-publishing.
//
// Deciding on bytes also lets the size gate run BEFORE anything is decoded, which is what the
// MAIN_REQUEST_MAX_LINE comment above has always claimed.
//
// There is no reset(): a reader lives in the per-worker getWorker() closure, and worker exit
// deletes the specifier from `workers`, so the next spawn builds a new closure with a new reader.
// The renderer needs an explicit reset (src/renderer/ipc.ts) only because its decoder is
// module-level and survives a respawn by design.
function createWorkerFrameReader () {
  let tail = EMPTY

  return {
    push (chunk) {
      const buf = tail.length === 0 ? chunk : Buffer.concat([tail, chunk])
      const lastNl = buf.lastIndexOf(NEWLINE)
      if (lastNl === -1) { tail = Buffer.from(buf); return [] }
      // Committed before the caller dispatches anything, so a throwing handler cannot cause the
      // frames after it to be re-read from a stale tail.
      tail = lastNl + 1 === buf.length ? EMPTY : Buffer.from(buf.subarray(lastNl + 1))

      const frames = []
      let start = 0
      while (start <= lastNl) {
        const nl = buf.indexOf(NEWLINE, start)
        const frame = buf.subarray(start, nl)
        start = nl + 1
        if (isControlFrameCandidate(frame)) frames.push(frame.toString('utf8'))
      }
      return frames
    },
  }
}

module.exports = { MAIN_REQUEST_MAX_LINE, isControlFrameCandidate, createWorkerFrameReader }
