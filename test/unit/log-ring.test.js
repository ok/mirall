import test from 'brittle'
import { createRequire } from 'module'
import { redactLine } from '../../src/shared/core/diagnostics-redact.js'

const require = createRequire(import.meta.url)
const { LogRing, MAX_LINES, MAX_LINE_LENGTH } = require('../../src/main/log-ring.js')

test('evicts by line count', (t) => {
  const ring = new LogRing()
  for (let i = 0; i < MAX_LINES + 10; i++) ring.push('worker', 'log', `line ${i}`)
  t.is(ring.size, MAX_LINES)
  t.ok(ring.snapshot()[0].text.startsWith('line 10'), 'oldest lines dropped first')
})

test('evicts by byte budget before hitting the line cap', (t) => {
  const ring = new LogRing()
  const chunk = 'x'.repeat(MAX_LINE_LENGTH)
  for (let i = 0; i < 500; i++) ring.push('worker', 'log', chunk)
  t.ok(ring.size < MAX_LINES, 'byte budget bit first')
  t.ok(ring.bytes <= 512 * 1024)
})

test('clamps an oversized single line at push time', (t) => {
  const ring = new LogRing()
  ring.push('worker', 'log', 'y'.repeat(MAX_LINE_LENGTH * 5))
  const [entry] = ring.snapshot()
  t.ok(entry.text.length <= MAX_LINE_LENGTH + 20)
  t.ok(entry.text.endsWith('…[truncated]'))
})

test('REGRESSION (FIX-4: snapshot must not drain) — preview then save keeps the logs', (t) => {
  const ring = new LogRing()
  ring.push('main', 'warn', 'something happened')
  const first = ring.snapshot()
  const second = ring.snapshot()
  t.is(first.length, 1)
  t.is(second.length, 1, 'a second read still returns the lines')
  t.is(ring.size, 1)
})

test('snapshot applies the redactor to every line', (t) => {
  const ring = new LogRing()
  ring.push('worker', 'log', 'dialing 198.51.100.4 from /Users/rene/Docs')
  ring.push('worker', 'log', 'key ' + 'a'.repeat(64))
  const out = ring.snapshot(redactLine)
  for (const entry of out) {
    t.absent(entry.text.includes('198.51.100.4'))
    t.absent(entry.text.includes('/Users/rene'))
    t.absent(entry.text.includes('a'.repeat(64)))
  }
})

test('REGRESSION (FIX-7: stream chunks are many lines) — a multi-line chunk becomes many entries', (t) => {
  // Worker stdout arrives as arbitrary chunks; charging one chunk as one entry truncated
  // it at MAX_LINE_LENGTH and threw most of a busy worker's output away.
  const ring = new LogRing()
  ring.push('worker', 'log', 'alpha\nbravo\ncharlie\n')
  t.is(ring.size, 3)
  t.alike(ring.snapshot().map((e) => e.text), ['alpha', 'bravo', 'charlie'])
})

test('ignores non-strings and blank lines', (t) => {
  const ring = new LogRing()
  ring.push('main', 'log', null)
  ring.push('main', 'log', '')
  ring.push('main', 'log', '   \n')
  t.is(ring.size, 0)
})

test('records the source and level for each line', (t) => {
  const ring = new LogRing()
  ring.push('renderer', 'err', 'boom')
  const [entry] = ring.snapshot()
  t.is(entry.source, 'renderer')
  t.is(entry.level, 'err')
  t.ok(entry.at > 0)
})
