// Runs flow test files under brittle with the three guarantees the plain `brittle-node`
// CLI does not give, and which a two-peer suite needs because any of its waits can time out:
//
//   1. A test body that throws is recorded as a `not ok` carrying the test name. brittle
//      rejects the test's promise instead of asserting on it, and nothing awaits that
//      promise, so an escaping throw is an unhandled rejection rather than a named failure.
//   2. A mid-run death (uncaught exception, unhandled rejection) exits non-zero and says so.
//   3. Every registered top-level test is accounted for at exit. A run that ends with
//      registered tests unexecuted is a truncated run, and a truncated run fails.
//
// Usage: node test/flow-runner.mjs <file|dir/*.suffix> ...
import { writeSync } from 'fs'
import path from 'path'
import { pathToFileURL } from 'url'
import { createRequire } from 'module'
import { resolveFiles } from './helpers/test-files.mjs'

const require = createRequire(import.meta.url)
const brittle = require('brittle')
const { Test } = brittle
const brittleVersion = require('brittle/package.json').version

// One record per top-level test, in registration order. `ran` flips when the body is
// entered, so anything left un-run at exit is a test the run never reached.
const records = []

// The three guarantees above are delivered by wrapping brittle's per-test entry point, which
// is internal to a caret-ranged dependency. A release that renames it or stops routing through
// it would leave the wrapper installed on nothing, restoring the silent-skip behaviour with no
// signal — so the shape is a hard precondition, not a best effort.
function patchTarget () {
  const target = Test?.prototype?._run
  if (typeof Test !== 'function' || typeof target !== 'function' || target.length !== 2) {
    say(`not ok - flow runner cannot wrap brittle ${brittleVersion}: Test.prototype._run(fn, opts) is not the shape it patches`)
    say('# update test/flow-runner.mjs for this brittle version — an unpatched run cannot be trusted')
    process.exit(1)
  }
  return target
}

const runTest = patchTarget()
Test.prototype._run = async function (fn, opts) {
  if (!this._isMain || this._isHook) return runTest.call(this, fn, opts)

  const record = { name: this.name, expected: !this._isSkip && !this._isTodo, ran: false }
  records.push(record)

  const guarded = async (t) => {
    record.ran = true
    try {
      return await fn(t)
    } catch (err) {
      t.fail(describe(err))
    }
  }

  try {
    return await runTest.call(this, guarded, opts)
  } catch (err) {
    // The body is guarded above, so this is brittle's own rejection path: a per-test
    // timeout, a teardown error, or the predecessor's rejection observed while queueing.
    record.ran = true
    process.exitCode = 1
    say(`not ok - ${this.name || '(unnamed test)'}`)
    say('# ' + describe(err).replace(/\n/g, '\n# '))
  }
}

// The runner's own lines are written synchronously: an exit handler's console.log to a pipe
// can be dropped as the process leaves, and these lines are the whole point of the runner.
function say (line) {
  writeSync(1, line + '\n')
}

function describe (err) {
  if (err instanceof Error) return err.stack || err.message
  return 'threw a non-Error value: ' + inspect(err)
}

function inspect (value) {
  try {
    return typeof value === 'string' ? value : JSON.stringify(value) ?? String(value)
  } catch {
    return String(value)
  }
}

function onFatal (label) {
  return (err) => {
    say(`not ok - flow run died mid-suite (${label})`)
    say('# ' + describe(err).replace(/\n/g, '\n# '))
    reportAccounting()
    process.exit(1)
  }
}

let reported = false
function reportAccounting () {
  if (reported) return
  reported = true
  const expected = records.filter((r) => r.expected)
  const missing = expected.filter((r) => !r.ran)
  say(`# flow accounting: ${expected.length - missing.length}/${expected.length} registered test(s) executed`)
  if (missing.length === 0) return
  say(`not ok - flow run truncated: ${missing.length} registered test(s) never executed`)
  for (const r of missing) say('# never executed: ' + r.name)
  process.exitCode = 1
}

process.on('uncaughtException', onFatal('uncaught exception'))
process.on('unhandledRejection', onFatal('unhandled rejection'))
process.on('exit', reportAccounting)

const args = process.argv.slice(2)
if (args.length === 0 || args.some((a) => a.startsWith('-'))) {
  console.error('usage: node test/flow-runner.mjs <file|dir/*.suffix> ...')
  process.exit(1)
}

process.title = 'brittle'
brittle.pause()
for (const file of resolveFiles(args)) {
  await brittle.load(pathToFileURL(path.resolve(file)).href)
}

// brittle registers a top-level test the moment its module body calls `test()`, so by now every
// test in the run has passed through the wrapper. None having done so means the wrap is inert —
// the second half of the precondition above, and the half a shape check cannot see.
if (records.length === 0) {
  say(`not ok - flow runner observed no registered tests: either the files hold none, or the brittle ${brittleVersion} wrap is not taking effect`)
  process.exit(1)
}

brittle.resume()
