// The flow runner is the thing under test here: it is what stands between a two-peer
// wait that times out and a run that looks like it passed. Each case spawns the runner
// over a fixture and reads its real tap output and exit code.
import test from 'brittle'
import { spawnSync } from 'child_process'
import { fileURLToPath } from 'url'
import path from 'path'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function runFixture(name, nodeArgs = []) {
  const r = spawnSync(process.execPath, [...nodeArgs, 'test/flow-runner.mjs', `test/fixtures/flow-runner/${name}`], {
    cwd: repo,
    encoding: 'utf8',
  })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

test('REGRESSION (RUNNER-1: a throwing test body is a named not ok, not a silent abort)', async (t) => {
  const { status, out } = runFixture('throwing.test.js')

  t.ok(out.includes('not ok 2 - throws like a timed-out until'), 'the failing test is named in a not ok')
  t.ok(out.includes('until() timed out on audit:list'), 'the failure carries the timeout diagnostic')
  t.ok(out.includes('ok 3 - runs after the throw'), 'the test after the throw still runs')
  t.ok(out.includes('# flow accounting: 3/3 registered test(s) executed'), 'every registered test is accounted for')
  t.not(status, 0, 'the run exits non-zero')
})

test('REGRESSION (RUNNER-2: a mid-run death fails the run and names the tests it never reached)', async (t) => {
  const { status, out } = runFixture('truncated.test.js')

  t.ok(out.includes('not ok - flow run died mid-suite'), 'the death is reported as a failure')
  t.ok(out.includes('background boom'), 'the fatal error is printed')
  t.ok(out.includes('not ok - flow run truncated: 1 registered test(s) never executed'), 'the truncation fails the run')
  t.ok(out.includes('# never executed: never executes'), 'the unreached test is named')
  t.not(status, 0, 'the run exits non-zero')
})

// The runner wraps an internal of a caret-ranged dependency. A bump that moves that internal must
// stop the run loudly, because a wrap that silently applies to nothing restores the very defect
// the two regressions above pin.
test('the runner refuses to start when brittle no longer has the entry point it wraps', async (t) => {
  const { status, out } = runFixture('clean.test.js', ['--import', './test/fixtures/flow-runner/break-brittle.mjs'])

  t.ok(out.includes('not ok - flow runner cannot wrap brittle'), 'the refusal is reported as a failure')
  t.ok(/brittle \d+\.\d+\.\d+/.test(out), 'the installed brittle version is named')
  t.ok(out.includes('update test/flow-runner.mjs'), 'the message says what to do')
  t.absent(out.includes('TAP version'), 'no tests are run unpatched')
  t.not(status, 0, 'the run exits non-zero')
})

test('the runner fails a run in which it observed no registered test', async (t) => {
  const { status, out } = runFixture('no-tests.test.js')

  t.ok(out.includes('not ok - flow runner observed no registered tests'), 'an empty run is a failure')
  t.not(status, 0, 'the run exits non-zero')
})

test('a clean run reports full accounting and exits zero', async (t) => {
  const { status, out } = runFixture('clean.test.js')

  t.ok(out.includes('# flow accounting: 2/2 registered test(s) executed'), 'accounting confirms the run was complete')
  t.absent(out.includes('not ok'), 'nothing is reported as failed')
  t.is(status, 0, 'the run exits zero')
})
