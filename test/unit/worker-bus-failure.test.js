import test from 'brittle'
import { createFailureGate } from '../../src/main/worker-bus-failure.js'
import { capture } from '../helpers/capture-console.js'

function gate({ debug = false, quitting = false } = {}) {
  const reports = []
  const report = createFailureGate({ isDebug: () => debug, isQuitting: () => quitting })
  const fail = (err) => report(err, (text) => ['bus failed:', text], (text) => reports.push(text))
  return { fail, reports }
}

test('a gate without isDebug or isQuitting is refused when it is built', (t) => {
  t.exception.all(() => createFailureGate({ isQuitting: () => false }), /isDebug and isQuitting/)
  t.exception.all(() => createFailureGate({ isDebug: () => false }), /isDebug and isQuitting/)
})

test('outside debug and outside a quit a failure goes to the reporter with its message', (t) => {
  const lines = capture(t, ['warn', 'error'])
  const { fail, reports } = gate()
  fail(new Error('EPIPE'))
  t.alike(reports, ['EPIPE'])
  t.alike(lines, { warn: [], error: [] }, 'the gate itself logs nothing')
})

test('in debug every failure is logged and the reporter is not called', (t) => {
  const lines = capture(t, ['error'])
  const { fail, reports } = gate({ debug: true })
  fail(new Error('EPIPE'))
  fail(new Error('EPIPE'))
  t.alike(lines.error, ['bus failed: EPIPE', 'bus failed: EPIPE'])
  t.alike(reports, [])
})

test('during a quit a failure is silent outside debug, and logged in debug', (t) => {
  const lines = capture(t, ['warn', 'error'])
  const quiet = gate({ quitting: true })
  quiet.fail(new Error('EPIPE'))
  t.alike(quiet.reports, [])
  t.alike(lines, { warn: [], error: [] })

  const loud = gate({ debug: true, quitting: true })
  loud.fail(new Error('EPIPE'))
  t.alike(lines.error, ['bus failed: EPIPE'], 'debug outranks the quit')
})

test('a non-Error failure is named by its value', (t) => {
  const { fail, reports } = gate()
  fail(undefined)
  fail('boom')
  fail({ code: 'X' })
  t.alike(reports, ['undefined', 'boom', '[object Object]'])
})

test('reporting cannot throw: not for an unprintable error, not for a throwing reporter', (t) => {
  const report = createFailureGate({ isDebug: () => false, isQuitting: () => false })
  t.execution(() => report(Object.create(null), () => [], () => {}), 'String() of a null-prototype object throws')
  t.execution(() => report(new Error('x'), () => [], () => { throw new Error('reporter') }))
  const debugReport = createFailureGate({ isDebug: () => { throw new Error('gate') }, isQuitting: () => false })
  t.execution(() => debugReport(new Error('x'), () => [], () => {}))
})
