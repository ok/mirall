import test from 'brittle'
import { createLogger } from '../../src/shared/core/logger.js'
import { setVerbose } from '../helpers/runtime-verbose.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const TAG = '[test]'

// Count only the logger's own emissions (it prefixes every line with `[module]`)
// and forward everything else to the real console, so brittle's own TAP output
// over console.log is untouched.
function captureLogger(t) {
  const real = { log: console.log, warn: console.warn, error: console.error }
  const counts = { log: 0, warn: 0, error: 0 }
  console.log = (...a) => { if (a[0] === TAG) { counts.log++; return } real.log(...a) }
  console.warn = (...a) => { if (a[0] === TAG) { counts.warn++; return } real.warn(...a) }
  console.error = (...a) => { if (a[0] === TAG) { counts.error++; return } real.error(...a) }
  t.teardown(() => {
    console.log = real.log
    console.warn = real.warn
    console.error = real.error
  })
  return counts
}

test('logger gates debug/info on the verbose flag, always emits warn/error', (t) => {
  const counts = captureLogger(t)
  const log = createLogger('test')

  setVerbose(t, false)
  log.debug('hidden')
  log.info('hidden')
  t.is(counts.log, 0, 'debug + info are silent when verbose is off')
  log.warn('shown')
  log.error('shown')
  t.is(counts.warn, 1, 'warn always emits')
  t.is(counts.error, 1, 'error always emits')
})

test('a live verbose flip changes an existing logger instance (per-call gate)', (t) => {
  const counts = captureLogger(t)
  const log = createLogger('test')

  setVerbose(t, false)
  log.debug('hidden')
  log.info('hidden')
  t.is(counts.log, 0, 'silent before the flip')

  // Flip verbose on at runtime — the same logger instance must now emit, since
  // it reads the flag on every call (this is what window.mirall.verbose relies on).
  setVerbose(t, true)
  log.debug('now shown')
  log.info('now shown')
  t.is(counts.log, 2, 'debug + info emit after the flip, no new logger needed')
})

test('a spawned worker\'s lines are exactly as they were; a headless one\'s open with the time', (t) => {
  const seen = []
  const real = console.warn
  console.warn = (...a) => { if (typeof a[0] === 'string' && a[0].endsWith('[stamp]')) { seen.push(a); return } real(...a) }
  t.teardown(() => { console.warn = real })
  const prev = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(prev))
  const log = createLogger('stamp')

  setRuntimeConfig({ ...prev })
  log.warn('plain', 1)
  t.alike(seen.pop(), ['[stamp]', 'plain', 1], 'no stamp, no change to the arguments')

  setRuntimeConfig({ ...prev, logTimestamps: true })
  log.warn('stamped', 2)
  const [head, ...rest] = seen.pop()
  t.ok(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z \[stamp\]$/.test(head), 'an ISO time, then the module')
  t.alike(rest, ['stamped', 2])
})
