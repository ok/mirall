import test from 'brittle'
import { MAIN_REQUEST_MAX_LINE, isControlFrameCandidate, createWorkerFrameReader } from '../../src/main/ipc-frame.js'

function muteWarn (t) {
  const original = console.warn
  const lines = []
  console.warn = (...args) => lines.push(args.join(' '))
  t.teardown(() => { console.warn = original })
  return lines
}

const frameFor = (mountPath) => Buffer.from(JSON.stringify({
  type: 'main-request',
  command: 'owned-folder:start-watcher',
  args: { shareId: 's1', mountPath },
}) + '\n')

// REGRESSION (FIX-143): main parsed EVERY worker→main pipe line with JSON.parse just to detect
// tiny 'main-request' control frames — so a multi-MB worker→renderer listing response blocked
// main's UI thread on a giant parse. isControlFrameCandidate gates by size so large frames are
// skipped (they're already broadcast to the renderer), while small control frames still parse.
test('REGRESSION (FIX-143): only small lines are control-frame candidates', (t) => {
  t.is(isControlFrameCandidate(''), false, 'empty line is not a frame')
  t.is(isControlFrameCandidate(JSON.stringify({ type: 'main-request', command: 'owned-folder:start-watcher' })), true, 'a real control frame qualifies')
  t.is(isControlFrameCandidate('x'.repeat(MAIN_REQUEST_MAX_LINE)), true, 'exactly at the limit qualifies')
  t.is(isControlFrameCandidate('x'.repeat(MAIN_REQUEST_MAX_LINE + 1)), false, 'one over the limit is skipped (a large listing response)')
})

// REGRESSION (FIX-H2-1: `workerBuffer += data.toString()` decoded each chunk independently, so a
// chunk boundary inside the two bytes of 'ü' produced U+FFFD on both halves. Measured before the
// fix: JSON.parse SUCCEEDED and mountPath came out '/Users/o/M��ller Projekte', so main
// armed a chokidar watcher on a path that does not exist — and chokidar reports nothing at all for
// a missing path, so the folder silently stopped re-publishing with no error anywhere.)
test('REGRESSION (FIX-H2-1): a frame split inside a 2-byte character survives the chunk boundary', (t) => {
  const buf = frameFor('/Users/o/Müller Projekte')
  const cut = buf.indexOf(0xC3) + 1
  const reader = createWorkerFrameReader()

  const first = reader.push(buf.subarray(0, cut))
  t.alike(first, [], 'no complete frame yet')
  const frames = reader.push(buf.subarray(cut))

  t.is(frames.length, 1, 'one frame')
  t.absent(frames[0].includes('�'), 'no replacement characters')
  t.is(JSON.parse(frames[0]).args.mountPath, '/Users/o/Müller Projekte')
})

// REGRESSION (FIX-H2-2: the same defect for 3- and 4-byte sequences, at every interior split.)
test('REGRESSION (FIX-H2-2): a 3- or 4-byte character split at any interior offset survives', (t) => {
  for (const mountPath of ['/Users/o/📁 Projekte', '/Users/o/项目']) {
    const buf = frameFor(mountPath)
    const lead = buf.findIndex((b) => b >= 0xC2)
    const width = buf[lead] >= 0xF0 ? 4 : buf[lead] >= 0xE0 ? 3 : 2
    for (let off = 1; off < width; off++) {
      const reader = createWorkerFrameReader()
      reader.push(buf.subarray(0, lead + off))
      const frames = reader.push(buf.subarray(lead + off))
      t.is(JSON.parse(frames[0]).args.mountPath, mountPath, `${mountPath} split at +${off}`)
    }
  }
})

test('a frame fed one byte at a time still yields exactly one intact frame', (t) => {
  const buf = frameFor('/Users/o/Müller 项目 📁')
  const reader = createWorkerFrameReader()
  const frames = []
  for (let i = 0; i < buf.length; i++) frames.push(...reader.push(buf.subarray(i, i + 1)))
  t.is(frames.length, 1)
  t.is(JSON.parse(frames[0]).args.mountPath, '/Users/o/Müller 项目 📁')
})

test('the size gate measures bytes, so a frame is gated the way the sender wrote it', (t) => {
  const reader = createWorkerFrameReader()
  // MAIN_REQUEST_MAX_LINE 2-byte characters: under the cap in UTF-16 code units, over it in bytes.
  const over = Buffer.from('ü'.repeat(MAIN_REQUEST_MAX_LINE) + '\n')
  t.is(over.length > MAIN_REQUEST_MAX_LINE, true, 'over the cap in bytes')
  t.alike(reader.push(over), [], 'refused on its real size')

  const atLimit = Buffer.concat([Buffer.from('x'.repeat(MAIN_REQUEST_MAX_LINE)), Buffer.from('\n')])
  t.is(reader.push(atLimit).length, 1, 'exactly at the limit still passes')
})

test('a chunk carrying many frames yields them all, in order', (t) => {
  const reader = createWorkerFrameReader()
  const chunk = Buffer.concat([frameFor('/a'), frameFor('/b'), frameFor('/c')])
  const frames = reader.push(chunk)
  t.alike(frames.map((f) => JSON.parse(f).args.mountPath), ['/a', '/b', '/c'])
})

test('an empty line is not a frame', (t) => {
  const reader = createWorkerFrameReader()
  const frames = reader.push(Buffer.concat([frameFor('/a'), Buffer.from('\n'), frameFor('/b')]))
  t.is(frames.length, 2, 'the blank line between two frames is dropped')
})

// The reader needs no reset() because it lives in the per-worker getWorker() closure and a worker
// exit deletes the specifier, so the next spawn builds a new one. Pin that.
test('a fresh reader carries no tail from the previous worker', (t) => {
  const buf = frameFor('/Users/o/Müller Projekte')
  const dead = createWorkerFrameReader()
  dead.push(buf.subarray(0, buf.indexOf(0xC3) + 1))

  const fresh = createWorkerFrameReader()
  const frames = fresh.push(frameFor('/fresh'))
  t.is(frames.length, 1)
  t.is(JSON.parse(frames[0]).args.mountPath, '/fresh')
})

// REGRESSION (FIX-R5: the reader had no resync. An unterminated frame was buffered whole before
// the size gate could refuse it, so a worker that never writes a newline grew the tail without
// bound — and every further chunk re-copied all of it, on main's UI thread. The gate's own header
// has always claimed it keeps a multi-MB frame off that thread.)
test('REGRESSION (FIX-R5): an unterminated oversized frame is dropped, not accumulated', (t) => {
  const reader = createWorkerFrameReader()
  const chunk = Buffer.alloc(64 * 1024, 0x78)

  for (let sent = 0; sent < 4 * 1024 * 1024; sent += chunk.length) {
    t.absent(reader.push(chunk).length, 'no frame from an unterminated stream')
  }
  t.ok(reader.bufferedBytes <= MAIN_REQUEST_MAX_LINE,
    `the tail stays bounded (${reader.bufferedBytes} bytes held after 4MB)`)

  // And the resync ends at the newline that ends the frame given up on, so the NEXT frame is intact.
  const frames = reader.push(Buffer.concat([Buffer.from('junk-tail\n'), frameFor('/after')]))
  t.is(frames.length, 1, 'the frame after the resync is delivered')
  t.is(JSON.parse(frames[0]).args.mountPath, '/after')
})

// A control frame refused on size arms no watcher. That is the same silent stop as FIX-H2-1, so it
// cannot be a quiet drop — while a large listing response, which main is right to skip, must stay
// quiet or the log ring fills with ordinary traffic.
test('an oversized control frame is said out loud; an oversized response is not', (t) => {
  const warnings = muteWarn(t)
  const reader = createWorkerFrameReader()

  const huge = { type: 'main-request', command: 'owned-folder:start-watcher', args: { shareId: 's1', ignore: ['x'.repeat(MAIN_REQUEST_MAX_LINE)] } }
  reader.push(Buffer.from(JSON.stringify(huge) + '\n'))
  t.is(warnings.length, 1, 'the dropped control frame is reported')
  t.ok(warnings[0].includes('control frame dropped'), warnings[0])

  reader.push(Buffer.from(JSON.stringify({ id: 7, data: { files: 'x'.repeat(MAIN_REQUEST_MAX_LINE) } }) + '\n'))
  t.is(warnings.length, 1, 'a large response frame is skipped in silence')

  // The frame that trips this is built from a share's own config, so re-arming its watcher
  // reproduces it exactly. One line per reader — the repeats would evict the log ring they land in.
  reader.push(Buffer.from(JSON.stringify(huge) + '\n'))
  t.is(warnings.length, 1, 'and the same drop is not reported twice')
})
