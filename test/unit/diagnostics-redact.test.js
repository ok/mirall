import test from 'brittle'
import { redactLine, shortId, makeAliaser } from '../../src/shared/core/diagnostics-redact.js'

test('redactLine removes IPv4', (t) => {
  t.is(redactLine('connecting to 192.168.1.44:41234'), 'connecting to ‹ip›:41234')
})

test('redactLine removes IPv6', (t) => {
  t.absent(redactLine('peer at 2001:db8:85a3::8a2e:370:7334 failed').includes('2001:db8'))
})

test('redactLine truncates hex keys', (t) => {
  const key = 'a'.repeat(64)
  const out = redactLine(`handshake from ${key}`)
  t.absent(out.includes(key))
  t.ok(out.includes('aaaa…'))
})

test('redactLine removes posix and windows paths', (t) => {
  t.is(redactLine('watching /Users/rene/Documents'), 'watching ‹path›')
  t.is(redactLine('watching C:\\Users\\rene\\Docs'), 'watching ‹path›')
})

test('REGRESSION (FIX-2: a path must not swallow the rest of the line)', (t) => {
  // An early version allowed spaces inside a path segment, so everything after a path —
  // including keys that still needed redacting — vanished into the placeholder.
  const out = redactLine('watching /Users/rene/Docs then dialed ' + 'b'.repeat(64))
  t.ok(out.includes('then dialed'), 'trailing text survives')
  t.ok(out.includes('bbbb…'), 'the trailing key is still redacted')
})

test('REGRESSION (FIX-8: IPv6 pattern ate clock times) — timestamps survive', (t) => {
  // The old `{0,4}` minimum matched any two-colon run, so redaction destroyed every
  // timestamp in the exported log.
  t.is(redactLine('2026-08-24 17:39:16 connecting'), '2026-08-24 17:39:16 connecting')
  t.is(redactLine('took 01:02:03 total'), 'took 01:02:03 total')
})

test('IPv6 still redacted in both full and compressed forms', (t) => {
  t.absent(redactLine('at 2001:0db8:85a3:0000:0000:8a2e:0370:7334 x').includes('2001'))
  t.absent(redactLine('at 2001:db8:85a3::8a2e:370:7334 x').includes('2001'))
  t.absent(redactLine('bound fe80::1 ok').includes('fe80'))
})

test('REGRESSION (FIX-9: non-ASCII paths kept the username)', (t) => {
  const out = redactLine('watching /Users/rené/Dokumente/Freigabe')
  t.absent(out.includes('rené'), 'the username must not survive')
  t.is(out, 'watching ‹path›')
})

test('redactLine is total — never throws, always a string', (t) => {
  for (const value of [null, undefined, 42, {}, []]) t.is(redactLine(value), '')
})

test('shortId truncates and never returns the full value', (t) => {
  const key = 'deadbeef'.repeat(8)
  t.is(shortId(key), 'dead…')
  t.absent(shortId(key).includes(key))
  t.is(shortId(null), null)
  t.is(shortId('ab', 4), '…')
})

test('makeAliaser is stable and non-reversible', (t) => {
  const alias = makeAliaser('t')
  const topic = 'f'.repeat(64)
  t.is(alias(topic), 't0')
  t.is(alias(topic), 't0', 'same input → same alias')
  t.is(alias('e'.repeat(64)), 't1')
  t.absent(String(alias(topic)).includes('ffff'))
  t.is(alias(null), null)
})
