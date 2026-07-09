import test from 'brittle'
import { scaled, summarize, tail, TIMEOUT_SCALE } from '../helpers/timing.js'

test('scaled multiplies the base by TIMEOUT_SCALE', (t) => {
  t.ok(TIMEOUT_SCALE > 0)
  t.is(scaled(20000), Math.round(20000 * TIMEOUT_SCALE))
  t.is(scaled(0), 0)
})

test('summarize truncates long values and survives cycles', (t) => {
  const long = summarize({ a: 'x'.repeat(2000) })
  t.ok(long.length < 1000 && long.includes('more chars'))
  const cyclic = {}
  cyclic.self = cyclic
  t.is(typeof summarize(cyclic), 'string')
})

test('tail placeholders empty input and suffixes long input', (t) => {
  t.is(tail(''), '(no worker stderr captured)')
  t.ok(tail('y'.repeat(3000)).startsWith('…'))
})
