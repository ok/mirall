import test from 'brittle'
import { createLogger, fields } from '../../src/shared/core/logger.js'
import { setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

function capture (t) {
  const lines = []
  const realLog = console.log
  const realWarn = console.warn
  const grab = (real) => (...a) => { if (a[0] === '[probe]') { lines.push(a.slice(1)); return } real(...a) }
  console.log = grab(realLog)
  console.warn = grab(realWarn)
  setRuntimeConfig({ verbose: true })
  t.teardown(() => { console.log = realLog; console.warn = realWarn; setRuntimeConfig({}) })
  return lines
}

const joined = (lines) => lines.map((a) => a.join(' '))

test('a field bag renders as ordered key=value after the message', (t) => {
  const lines = capture(t)
  createLogger('probe').warn('mirror stalled', fields({ spaceId: 'S1', shareId: 'F2', attempt: 3 }))
  t.is(joined(lines)[0], 'mirror stalled spaceId=S1 shareId=F2 attempt=3')
})

// The property that makes this safe to land without auditing the ~330 positional call sites: a bag
// is recognised by a symbol tag, never by shape, so an object someone logs today is untouched.
test('REGRESSION (FIX-R09-7): a plain object argument is not read as a field bag', (t) => {
  const lines = capture(t)
  createLogger('probe').warn('peer state', { spaceId: 'S1' })
  t.alike(lines[0], ['peer state', { spaceId: 'S1' }], 'the object prints exactly as it did before')
})

test('null and undefined fields are omitted rather than printed', (t) => {
  const lines = capture(t)
  createLogger('probe').warn('partial', fields({ a: 1, b: null, c: undefined, d: 2 }))
  t.is(joined(lines)[0], 'partial a=1 d=2')
})

test('a value containing a space is quoted so key=value stays parseable', (t) => {
  const lines = capture(t)
  createLogger('probe').warn('msg', fields({ note: 'two words', plain: 'one' }))
  t.is(joined(lines)[0], 'msg note="two words" plain=one')
})

test('an empty string is quoted rather than rendering as a bare key=', (t) => {
  const lines = capture(t)
  createLogger('probe').warn('msg', fields({ empty: '' }))
  t.is(joined(lines)[0], 'msg empty=""')
})

test('a bag with nothing renderable drops the argument entirely', (t) => {
  const lines = capture(t)
  createLogger('probe').warn('bare', fields({ a: null }))
  t.alike(lines[0], ['bare'], 'no trailing empty string')
})

test('false and zero are rendered, not treated as absent', (t) => {
  const lines = capture(t)
  createLogger('probe').warn('flags', fields({ ok: false, count: 0 }))
  t.is(joined(lines)[0], 'flags ok=false count=0')
})

test('the level gate still applies to a line carrying fields', (t) => {
  const lines = capture(t)
  setRuntimeConfig({ verbose: false })
  const log = createLogger('probe')
  log.debug('hidden', fields({ a: 1 }))
  t.is(lines.length, 0, 'debug stays below the default level')
  log.warn('shown', fields({ a: 1 }))
  t.is(joined(lines)[0], 'shown a=1', 'warn survives it')
})

// Symbol.for and not Symbol(): a module reached through two specifiers would otherwise mint two
// tags, and a bag built under one would render as a raw object under the other.
test('the field tag is registry-global so two module copies agree', (t) => {
  const lines = capture(t)
  createLogger('probe').warn('cross', { [Symbol.for('mirall.logFields')]: { a: 1 } })
  t.is(joined(lines)[0], 'cross a=1')
})
