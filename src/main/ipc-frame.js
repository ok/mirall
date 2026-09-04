'use strict'

const { MAIN_REQUEST_FRAME } = require('../shared/contract/main-requests.js')

// Worker→main control frames ('main-request', e.g. start-watcher) are tiny — a command plus a
// few path args. Anything larger on the shared worker pipe is a worker→renderer response (e.g. a
// big file listing) that main has already broadcast and must NOT JSON.parse on its UI thread.
// This gate is what keeps a multi-MB response frame off main's main thread.
const MAIN_REQUEST_MAX_LINE = 64 * 1024

const NEWLINE = 0x0A
const EMPTY = Buffer.alloc(0)

// Long enough to cover the frame's own `type` — emit() writes it first — and short enough that
// probing can never amount to decoding a multi-MB response.
const CONTROL_FRAME_PROBE = 64
const CONTROL_FRAME_MARK = Buffer.from(JSON.stringify(MAIN_REQUEST_FRAME))

// A dropped control frame is the silent-no-watcher failure this module exists to prevent, so it is
// the one drop that must be said out loud. Everything else the gate refuses is a worker→renderer
// response main is right to skip, and saying THAT out loud would fill the log ring with ordinary
// traffic.
//
// Once per reader, because the frame that trips this is built from a share's own configuration:
// the same share re-arming its watcher reproduces it exactly, and a repeat says nothing the first
// line did not. A reader lives and dies with its worker, so a respawn reports again.
function createDropWarning () {
  let warned = false
  return (frame) => {
    if (warned) return
    if (!frame.subarray(0, CONTROL_FRAME_PROBE).includes(CONTROL_FRAME_MARK)) return
    warned = true
    console.warn('[main-request] control frame dropped:', frame.length, 'bytes exceeds', MAIN_REQUEST_MAX_LINE)
  }
}

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
  const warnIfControlFrame = createDropWarning()
  let tail = EMPTY
  // Once an unterminated buffer passes the cap it can no longer become a control frame, so it is
  // dropped and the reader resyncs at the next newline. Without it the tail grows without bound
  // against a worker that never terminates a frame, and every subsequent chunk re-copies all of
  // it — on main's UI thread. The twin reader in src/shared/core/ipc.js has always had this.
  let skipping = false

  return {
    push (chunk) {
      let buf = chunk
      // Whether `buf` is memory of ours or still the caller's chunk, which the pipe is free to
      // reuse once this handler returns. Only an owned buffer may be held across ticks as-is.
      let owned = false

      if (skipping) {
        const nl = chunk.indexOf(NEWLINE)
        if (nl === -1) return []
        buf = chunk.subarray(nl + 1)
        skipping = false
      } else if (tail.length !== 0) {
        buf = Buffer.concat([tail, chunk])
        owned = true
      }

      const lastNl = buf.lastIndexOf(NEWLINE)
      if (lastNl === -1) {
        if (buf.length > MAIN_REQUEST_MAX_LINE) {
          warnIfControlFrame(buf)
          tail = EMPTY
          skipping = true
          return []
        }
        // Buffer.concat already returned a private buffer; copying that again would be a second
        // full memcpy per chunk, for every partial frame, on main's UI thread.
        tail = owned ? buf : Buffer.from(buf)
        return []
      }
      // Committed before the caller dispatches anything, so a throwing handler cannot cause the
      // frames after it to be re-read from a stale tail. Copied rather than kept as a view: a
      // subarray would retain the whole concatenated buffer for the sake of a few trailing bytes.
      tail = lastNl + 1 === buf.length ? EMPTY : Buffer.from(buf.subarray(lastNl + 1))

      const frames = []
      let start = 0
      while (start <= lastNl) {
        const nl = buf.indexOf(NEWLINE, start)
        const frame = buf.subarray(start, nl)
        start = nl + 1
        if (isControlFrameCandidate(frame)) frames.push(frame.toString('utf8'))
        else if (frame.length > 0) warnIfControlFrame(frame)
      }
      return frames
    },

    // The memory bound this reader promises: the bytes it holds across chunks. Read by the test —
    // the difference the resync makes is a bound, and a bound is not visible in the frames out.
    get bufferedBytes () { return tail.length },
  }
}

module.exports = { MAIN_REQUEST_MAX_LINE, isControlFrameCandidate, createWorkerFrameReader }
