// The bare runner is what stands between an integration file that aborts its process and a CI log
// that names nothing. Each case spawns the real runner over fixtures and reads its output, exit
// code and flake report.
import test from 'brittle'
import { spawnSync } from 'child_process'
import { readFileSync, rmSync } from 'fs'
import { fileURLToPath } from 'url'
import os from 'os'
import path from 'path'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..')
const fixture = (name) => `test/fixtures/bare-runner/${name}`

function runRunner (args) {
  const r = spawnSync(process.execPath, ['test/bare-runner.mjs', ...args], { cwd: repo, encoding: 'utf8' })
  return { status: r.status, out: `${r.stdout}${r.stderr}` }
}

test('REGRESSION (FIX-255: an aborting file is named, and takes no other file with it)', async (t) => {
  const { status, out } = runRunner(['--jobs', '2', fixture('aborting.test.js'), fixture('passing.test.js')])

  t.ok(out.includes(`FAIL ${fixture('aborting.test.js')}`), 'the file that aborted is named')
  t.ok(out.includes('exit 134'), 'with how it died')
  t.ok(out.includes('nothing awaits this'), 'and its output is printed, not swallowed')
  t.ok(out.includes(`ok   ${fixture('passing.test.js')}`), 'the sibling file still ran and passed')
  t.not(status, 0, 'the run exits non-zero')
})

test('a file that exits 0 without a summary fails instead of counting as a pass', async (t) => {
  const { status, out } = runRunner([fixture('early-exit.test.js')])

  t.ok(out.includes('exited 0 without a brittle summary'), 'the truncation is the stated reason')
  t.not(status, 0, 'the run exits non-zero')
})

test('a file that registers no test fails instead of counting as a pass', async (t) => {
  const { status, out } = runRunner([fixture('no-tests.test.js')])

  t.ok(out.includes('registered no tests'), 'an empty file is a failure, not a silent skip')
  t.not(status, 0, 'the run exits non-zero')
})

test('a retry pass names what it retried and writes the flake report the ledger grades', async (t) => {
  const report = path.join(os.tmpdir(), `bare-runner-report-${Date.now()}.json`)
  t.teardown(() => { try { rmSync(report) } catch {} })

  const { status, out } = runRunner([
    '--retries', '1', '--report', report, '--shard-label', '7',
    fixture('failing.test.js'), fixture('passing.test.js'),
  ])

  t.ok(out.includes('retrying 1 failed file(s)'), 'only the failed file is retried')
  t.not(status, 0, 'a file that fails both attempts still fails the run')

  const written = JSON.parse(readFileSync(report, 'utf8'))
  t.is(written.shard, '7', 'the report carries its shard label')
  t.alike(written.files, [{ file: fixture('failing.test.js'), attempts: 2, passedOnRetry: false }],
    'a file that failed twice is recorded as a hard failure, not a flake')
})

test('a clean run reports every file and exits zero', async (t) => {
  const { status, out } = runRunner([fixture('passing.test.js')])

  t.ok(out.includes('1/1 file(s), 1/1 test(s) passed'), 'the file and test totals are both stated')
  t.is(status, 0, 'and the run is green')
})
