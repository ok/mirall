import test from 'brittle'
import { createFrameReader } from '../../src/shared/core/frame-reader.js'

const CAP = 1024

function reader({ maxFrameBytes = CAP } = {}) {
  const oversized = []
  const r = createFrameReader({ maxFrameBytes, onOversized: (n) => oversized.push(n) })
  return { r, oversized }
}

const frameFor = (v) => Buffer.from(JSON.stringify({ id: 1, type: 'echo', v }) + '\n')
const valueOf = (line) => JSON.parse(line).v

test('a frame arriving whole is returned whole', (t) => {
  const { r, oversized } = reader()
  const lines = r.push(frameFor('hi'))
  t.is(lines.length, 1)
  t.is(valueOf(lines[0]), 'hi')
  t.alike(oversized, [], 'nothing was refused')
  t.is(r.bufferedBytes, 0, 'and nothing is held')
})

test('a frame split across two chunks reassembles', (t) => {
  const { r } = reader()
  const buf = frameFor('hi')
  t.alike(r.push(buf.subarray(0, 6)), [], 'no complete frame yet')
  const lines = r.push(buf.subarray(6))
  t.is(lines.length, 1)
  t.is(valueOf(lines[0]), 'hi')
})

test('a frame split inside a multi-byte character survives the boundary', (t) => {
  for (const v of ['Müller Projekte', '项目', '📁 Projekte']) {
    const buf = frameFor(v)
    const lead = buf.findIndex((b) => b >= 0xC2)
    const width = buf[lead] >= 0xF0 ? 4 : buf[lead] >= 0xE0 ? 3 : 2
    for (let off = 1; off < width; off++) {
      const { r } = reader()
      r.push(buf.subarray(0, lead + off))
      const lines = r.push(buf.subarray(lead + off))
      t.is(lines.length, 1, `${v} split at +${off} yields one frame`)
      t.absent(lines[0].includes('�'), 'no replacement characters')
      t.is(valueOf(lines[0]), v)
    }
  }
})

test('a frame fed one byte at a time yields exactly one intact frame', (t) => {
  const { r } = reader()
  const buf = frameFor('Müller 项目 📁')
  const lines = []
  for (let i = 0; i < buf.length; i++) lines.push(...r.push(buf.subarray(i, i + 1)))
  t.is(lines.length, 1)
  t.is(valueOf(lines[0]), 'Müller 项目 📁')
})

test('a chunk carrying many frames yields them all, in order', (t) => {
  const { r } = reader()
  const lines = r.push(Buffer.concat([frameFor('a'), frameFor('b'), frameFor('c')]))
  t.alike(lines.map(valueOf), ['a', 'b', 'c'])
})

test('an empty line between two frames is dropped, and is not an oversize refusal', (t) => {
  const { r, oversized } = reader()
  const lines = r.push(Buffer.concat([frameFor('a'), Buffer.from('\n'), frameFor('b')]))
  t.is(lines.length, 2, 'the blank line is dropped')
  t.alike(oversized, [], 'a zero-length line is not measured against the cap')
})

// Padding a frame to an exact byte length: the JSON envelope is fixed, so the value carries the
// slack. Asserted rather than assumed, since the whole point is the boundary.
function frameOfBytes(n) {
  const envelope = frameFor('').length - 1
  const buf = frameFor('x'.repeat(n - envelope))
  if (buf.length - 1 !== n) throw new Error(`built ${buf.length - 1} bytes, wanted ${n}`)
  return buf
}

test('a frame exactly at the cap is returned; one byte over is refused', (t) => {
  const atCap = reader()
  const lines = atCap.r.push(frameOfBytes(CAP))
  t.is(lines.length, 1, 'exactly at the cap passes')
  t.alike(atCap.oversized, [])

  const over = reader()
  t.alike(over.r.push(frameOfBytes(CAP + 1)), [], 'one byte over is refused')
  t.alike(over.oversized, [CAP + 1], 'and reported at its measured size')
})

test('the cap measures bytes, not UTF-16 code units', (t) => {
  const { r, oversized } = reader()
  const buf = Buffer.from('ü'.repeat(CAP) + '\n')
  t.is(buf.length - 1, 2 * CAP, 'under the cap in code units, over it in bytes')
  t.alike(r.push(buf), [], 'refused on its real size')
  t.alike(oversized, [2 * CAP])
})

test('an unterminated stream stays bounded', (t) => {
  const { r, oversized } = reader()
  const chunk = Buffer.alloc(64 * 1024, 0x78)

  for (let sent = 0; sent < 4 * 1024 * 1024; sent += chunk.length) {
    t.absent(r.push(chunk).length, 'no frame from an unterminated stream')
  }
  t.ok(r.bufferedBytes <= CAP, `the buffer stays bounded (${r.bufferedBytes} bytes held after 4MB)`)
  t.ok(oversized.length > 0, 'and every refusal was reported')

  const lines = r.push(Buffer.concat([Buffer.from('junk-tail\n'), frameFor('after')]))
  t.is(lines.length, 1, 'the resync ends at the newline that ends the discarded frame')
  t.is(valueOf(lines[0]), 'after')
})

test('the tail of a discarded frame is never returned as a frame', (t) => {
  const { r } = reader()
  r.push(Buffer.alloc(2048, 0x78))
  t.alike(r.push(frameFor('forged')), [], 'the tail of the discarded frame is eaten by the resync')
  const lines = r.push(frameFor('real'))
  t.is(lines.length, 1, 'and the reader is live again afterwards')
  t.is(valueOf(lines[0]), 'real')
})

test('an oversized frame that arrives WITH its terminator is refused too', (t) => {
  const { r, oversized } = reader()
  const lines = r.push(Buffer.concat([frameOfBytes(CAP + 1), frameFor('after')]))
  t.is(lines.length, 1, 'only the frame under the cap is returned')
  t.is(valueOf(lines[0]), 'after')
  t.alike(oversized, [CAP + 1], 'the terminated frame was measured on itself')
})

test('a resync across a mid-character boundary does not corrupt the next frame', (t) => {
  const { r } = reader()
  r.push(Buffer.alloc(2048, 0x78))

  const next = Buffer.concat([Buffer.from('\n'), frameFor('Müller 项目')])
  const lead = next.findIndex((b) => b >= 0xC2)
  r.push(next.subarray(0, lead + 1))
  const lines = r.push(next.subarray(lead + 1))

  t.is(lines.length, 1)
  t.absent(lines[0].includes('�'), 'no replacement characters')
  t.is(valueOf(lines[0]), 'Müller 项目')
})

test('a chunk is never held as-is across ticks', (t) => {
  const { r } = reader()
  const buf = frameFor('Müller')
  const head = Buffer.from(buf.subarray(0, 8))
  r.push(head)
  // What the pipe is free to do the moment push() returns.
  head.fill(0x41)
  const lines = r.push(buf.subarray(8))
  t.is(lines.length, 1)
  t.is(valueOf(lines[0]), 'Müller', 'the held bytes were a copy, not the caller\'s chunk')
})

test('a fresh reader carries no state from a previous one', (t) => {
  const buf = frameFor('Müller')
  const dead = reader()
  dead.r.push(buf.subarray(0, buf.indexOf(0xC3) + 1))

  const fresh = reader()
  const lines = fresh.r.push(frameFor('fresh'))
  t.is(lines.length, 1)
  t.is(valueOf(lines[0]), 'fresh')
})
