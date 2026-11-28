import test from 'brittle'
import {
  REQUIRED_WORKFLOWS, TEST_STATE, decidingRun, releaseTestVerdict, describeResult,
} from '../../scripts/ci/require-green-tests.mjs'

const SHA = '6be9f3e8000e11e6332d7938e2fab750573de47b'
const OTHER_SHA = '114c2103aa0e11e6332d7938e2fab750573de47b'

// The fields of a `workflow_runs` entry the decision reads, as
// GET /repos/{owner}/{repo}/actions/workflows/test.yml/runs?head_sha=<sha> returns them.
const RECORDED_RUN = Object.freeze({
  id: 45474097313,
  name: 'Test',
  path: '.github/workflows/test.yml',
  head_branch: 'release/1.14',
  head_sha: SHA,
  event: 'push',
  status: 'completed',
  conclusion: 'success',
  run_attempt: 1,
  created_at: '2026-11-24T19:48:26Z',
  run_started_at: '2026-11-24T19:48:26Z',
  html_url: 'https://github.com/example/app/actions/runs/45474097313',
})

const run = (overrides = {}) => ({ ...RECORDED_RUN, ...overrides })
const earlier = (overrides = {}) => run({
  id: 45472178138,
  head_branch: 'main',
  created_at: '2026-11-24T19:37:29Z',
  run_started_at: '2026-11-24T19:37:29Z',
  html_url: 'https://github.com/example/app/actions/runs/45472178138',
  ...overrides,
})

const stateOf = (runs) => releaseTestVerdict(SHA, { 'test.yml': runs }).results[0].state
const passes = (runs) => releaseTestVerdict(SHA, { 'test.yml': runs }).ok
const messageFor = (runs) =>
  describeResult(releaseTestVerdict(SHA, { 'test.yml': runs }).results[0], { sha: SHA, ref: 'v1.14.0' })

test('the release needs exactly the Test workflow', (t) => {
  t.alike([...REQUIRED_WORKFLOWS], ['test.yml'])
})

test('a commit whose latest test run succeeded may be released', (t) => {
  const verdict = releaseTestVerdict(SHA, { 'test.yml': [run()] })
  t.ok(verdict.ok)
  t.is(verdict.results[0].state, TEST_STATE.GREEN)
  t.is(verdict.results[0].run.id, RECORDED_RUN.id, 'the verdict names the run that decided')
  t.ok(passes([run({ event: 'workflow_dispatch' })]), 'a dispatched run counts like a push run')
})

test('a commit whose test run did not succeed is refused', (t) => {
  for (const conclusion of ['failure', 'cancelled', 'timed_out', 'skipped', 'startup_failure', 'neutral']) {
    const runs = [run({ conclusion })]
    t.absent(passes(runs), `${conclusion} does not pass`)
    t.is(stateOf(runs), TEST_STATE.FAILED)
    t.ok(messageFor(runs).includes(`(${conclusion})`), `the message names ${conclusion}`)
  }
})

test('a commit whose test run has not finished is refused', (t) => {
  for (const status of ['in_progress', 'queued', 'requested', 'waiting', 'pending']) {
    const runs = [run({ status, conclusion: null })]
    t.absent(passes(runs), `${status} does not pass`)
    t.is(stateOf(runs), TEST_STATE.RUNNING)
  }
})

test('a commit with no test run is refused', (t) => {
  t.absent(passes([]))
  t.is(stateOf([]), TEST_STATE.MISSING)
  const unlisted = releaseTestVerdict(SHA, {})
  t.absent(unlisted.ok, 'a workflow the lookup never answered for has no run')
  t.is(unlisted.results[0].state, TEST_STATE.MISSING)
})

test('with two runs on one commit the later one decides, whatever order they arrive in', (t) => {
  const laterGreen = [run(), earlier({ conclusion: 'failure' })]
  t.ok(passes(laterGreen), 'a later success outweighs an earlier failure')
  t.ok(passes([...laterGreen].reverse()), 'in either order')

  const laterRed = [run({ conclusion: 'failure' }), earlier()]
  t.absent(passes(laterRed), 'a later failure outweighs an earlier success')
  t.absent(passes([...laterRed].reverse()), 'in either order')

  const laterRunning = [run({ status: 'in_progress', conclusion: null }), earlier()]
  t.is(stateOf(laterRunning), TEST_STATE.RUNNING, 'a later run still going outweighs an earlier success')
  t.is(stateOf([...laterRunning].reverse()), TEST_STATE.RUNNING, 'in either order')

  const sameSecond = [run({ id: 2, conclusion: 'failure' }), run({ id: 1 })]
  t.absent(passes(sameSecond), 'runs created in the same second are ordered by id')
  t.absent(passes([...sameSecond].reverse()))
})

test('a run from an event that does not test the commit itself is not counted', (t) => {
  t.is(stateOf([run({ event: 'pull_request' })]), TEST_STATE.MISSING, 'a pull_request run alone is no run')
  t.is(stateOf([run({ event: 'pull_request_target' })]), TEST_STATE.MISSING)
  t.is(stateOf([run({ event: 'schedule' })]), TEST_STATE.MISSING)
  t.absent(passes([run({ event: 'pull_request' }), earlier({ conclusion: 'failure' })]),
    'a later pull_request success does not outweigh a failed push run')
  t.ok(passes([run({ event: 'pull_request', conclusion: 'failure' }), earlier()]),
    'a later pull_request failure does not outweigh a passed push run')
})

test('a run on another commit is not counted', (t) => {
  t.is(stateOf([run({ head_sha: OTHER_SHA })]), TEST_STATE.MISSING)
  t.is(decidingRun(SHA, [run({ head_sha: OTHER_SHA }), earlier({ conclusion: 'failure' })]).id, 45472178138)
})

test('a re-run decides through its current attempt', (t) => {
  t.ok(passes([run({ run_attempt: 2, run_started_at: '2026-11-24T21:02:11Z' })]),
    'a failed run re-run to success passes')
  t.is(stateOf([run({ run_attempt: 2, status: 'in_progress', conclusion: null })]), TEST_STATE.RUNNING,
    'a run being re-run is not finished, whatever its previous attempt concluded')
  t.absent(passes([run({ run_attempt: 3, conclusion: 'failure' })]), 'a re-run that failed again does not pass')

  const rerunOfTheEarlier = earlier({ run_attempt: 2, run_started_at: '2026-11-24T22:15:00Z' })
  t.absent(passes([run({ conclusion: 'failure' }), rerunOfTheEarlier]),
    'a re-run keeps its creation time, so it does not overtake a run created after it')
})

test('every required workflow has to be green', (t) => {
  const required = ['test.yml', 'other.yml']
  t.absent(releaseTestVerdict(SHA, { 'test.yml': [run()] }, required).ok)
  t.absent(releaseTestVerdict(SHA, { 'test.yml': [run()], 'other.yml': [run({ conclusion: 'failure' })] }, required).ok)
  t.ok(releaseTestVerdict(SHA, { 'test.yml': [run()], 'other.yml': [run()] }, required).ok)
})

test('each refusal reads differently and says what to do next', (t) => {
  const missing = messageFor([])
  const running = messageFor([run({ status: 'in_progress', conclusion: null })])
  const failed = messageFor([run({ conclusion: 'failure' })])

  t.is(missing, 'test.yml has no run for commit 6be9f3e8. Start one with ' +
    '"gh workflow run test.yml --ref v1.14.0", wait for it to pass, then re-run this job.')
  t.is(running, 'test.yml is still running for commit 6be9f3e8 (in_progress): ' +
    'https://github.com/example/app/actions/runs/45474097313 Wait for it to finish, then re-run this job.')
  t.is(failed, 'test.yml did not pass for commit 6be9f3e8 (failure): ' +
    'https://github.com/example/app/actions/runs/45474097313 ' +
    'Re-run its failed jobs until it passes, then re-run this job.')
  t.is(messageFor([run()]),
    'test.yml passed for commit 6be9f3e8: https://github.com/example/app/actions/runs/45474097313')
})
