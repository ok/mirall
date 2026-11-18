import test from 'brittle'
import { rendererLogLine } from '../../src/main/renderer-console.js'

const PREFIX = '[main] '
const at = (o) => ({ message: 'hello', lineNumber: 7, sourceId: 'app://x/main.js', ...o })

test('a console message becomes source, line and text under its level', (t) => {
  t.alike(rendererLogLine(at({ level: 'warning' }), PREFIX), { tag: 'WARNING', text: 'app://x/main.js:7 hello' })
  t.is(rendererLogLine(at({ level: 'error' }), PREFIX).tag, 'ERROR')
  t.is(rendererLogLine(at({ level: 'info' }), PREFIX).tag, 'INFO')
})

test('the lowest level keeps the name the log has always used', (t) => {
  t.is(rendererLogLine(at({ level: 'debug' }), PREFIX).tag, 'VERBOSE')
})

test('an unknown level is logged as info rather than dropped', (t) => {
  t.is(rendererLogLine(at({ level: 'trace' }), PREFIX).tag, 'INFO')
})

test('a forwarded main line is not mirrored back', (t) => {
  t.is(rendererLogLine(at({ message: '[main] started' }), PREFIX), null)
})
