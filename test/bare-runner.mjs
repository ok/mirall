// Runs the integration suite as one bare PROCESS per test file, `--jobs` of them at a time.
//
// brittle's own `-j` is threads inside a single process: one fd table, one file-lock namespace, one
// heap for 200 files. Any file that dies from an unhandled rejection takes the whole run with it,
// and Bare aborts before brittle can print a summary — so the log names no test, no file and no
// totals. Process isolation makes every death attributable to the file it happened in, bounds it to
// that file, and is what lets a failed file be retried on its own.
//
// Usage: node test/bare-runner.mjs [--jobs N] [--retries N] [--report FILE] [--shard-label L]
//        <file|dir/*.suffix> ...
import { spawn } from 'child_process'
import { mkdirSync, writeFileSync } from 'fs'
import path from 'path'
import { resolveFiles } from './helpers/test-files.mjs'

// A file that produces nothing for this long is not slow, it is wedged: brittle's own per-test
// timeout (30s by default, and never more than a few minutes where a test sets its own) has had
// every chance to fire first.
const FILE_TIMEOUT_MS = 15 * 60 * 1000

const flags = { jobs: 4, retries: 0, report: null, shardLabel: '1' }
const files = resolveFiles(readFlags(process.argv.slice(2)))

function readFlags (argv) {
  const rest = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (arg === '--jobs' || arg === '-j') flags.jobs = Number(argv[++i])
    else if (arg === '--retries') flags.retries = Number(argv[++i])
    else if (arg === '--report') flags.report = argv[++i]
    else if (arg === '--shard-label') flags.shardLabel = argv[++i]
    else if (arg.startsWith('-')) fail(`unknown flag: ${arg}`)
    else rest.push(arg)
  }
  if (!Number.isInteger(flags.jobs) || flags.jobs < 1) fail('--jobs takes a positive integer')
  if (!Number.isInteger(flags.retries) || flags.retries < 0) fail('--retries takes a non-negative integer')
  if (rest.length === 0) fail('usage: node test/bare-runner.mjs [--jobs N] <file|dir/*.suffix> ...')
  return rest
}

function fail (message) {
  console.error(`Error: ${message}`)
  process.exit(1)
}

// The bare binary lives in node_modules/.bin, which npm puts on PATH for a script it runs but which
// a direct `node test/bare-runner.mjs` does not have. brittle-bare's shebang resolves `bare` from
// PATH, so the child gets it either way.
function childEnv () {
  const bin = path.resolve('node_modules/.bin')
  return { ...process.env, PATH: `${bin}${path.delimiter}${process.env.PATH || ''}` }
}

function runFile (file) {
  return new Promise((resolve) => {
    const startedAt = Date.now()
    const child = spawn(path.join('node_modules', '.bin', 'brittle-bare'), [file], {
      env: childEnv(),
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })

    const killer = setTimeout(() => {
      output += `\n# bare runner: no exit after ${FILE_TIMEOUT_MS}ms — killed\n`
      child.kill('SIGKILL')
    }, FILE_TIMEOUT_MS)

    child.on('error', (err) => {
      clearTimeout(killer)
      resolve({ file, ok: false, why: err.message, passed: 0, total: 0, ms: Date.now() - startedAt, output })
    })
    child.on('close', (code, signal) => {
      clearTimeout(killer)
      resolve({ file, ...verdict(code, signal, output), ms: Date.now() - startedAt, output })
    })
  })
}

// A run is good only if brittle got far enough to say so, about at least one test. Both of the
// other shapes exit 0 and read as a pass to an exit-code check: a process that left before its
// tests did, and a file whose tests never registered at all.
function verdict (code, signal, output) {
  const summary = /^# tests = (\d+)\/(\d+) pass$/m.exec(output)
  const counted = summary ? { passed: Number(summary[1]), total: Number(summary[2]) } : { passed: 0, total: 0 }
  if (signal) return { ok: false, why: `killed by ${signal}`, ...counted }
  if (code !== 0) return { ok: false, why: `exit ${code}`, ...counted }
  if (!summary || !/^# ok$/m.test(output)) return { ok: false, why: 'exited 0 without a brittle summary', ...counted }
  if (counted.total === 0) return { ok: false, why: 'registered no tests', ...counted }
  return { ok: true, why: 'ok', ...counted }
}

async function runAll (queue, jobs) {
  const results = []
  let next = 0
  const worker = async () => {
    while (next < queue.length) {
      const file = queue[next++]
      const result = await runFile(file)
      results.push(result)
      console.log(`${result.ok ? 'ok  ' : 'FAIL'} ${file} (${result.ms}ms${result.ok ? '' : `, ${result.why}`})`)
      if (!result.ok) process.stdout.write(result.output)
    }
  }
  await Promise.all(Array.from({ length: Math.min(jobs, queue.length) }, worker))
  return results
}

console.log(`bare runner: ${files.length} file(s), ${flags.jobs} at a time, one process each`)
const first = await runAll(files, flags.jobs)
const failed = first.filter((r) => !r.ok).map((r) => r.file).sort()

const entries = []
let hardFailures = failed
if (failed.length > 0 && flags.retries > 0) {
  console.log(`\nretrying ${failed.length} failed file(s) once, one at a time:\n`)
  const retried = await runAll(failed, 1)
  hardFailures = retried.filter((r) => !r.ok).map((r) => r.file).sort()
  for (const r of retried) entries.push({ file: r.file, attempts: 2, passedOnRetry: r.ok })
}

if (flags.report) {
  mkdirSync(path.dirname(flags.report), { recursive: true })
  writeFileSync(flags.report, JSON.stringify({ shard: flags.shardLabel, files: entries }) + '\n')
}

// The per-file totals are re-stated as one line: a suite that only ever reported per file cannot
// say whether a shard shrank, which is the same blindness as a run with no summary at all.
const tests = first.reduce((sum, r) => ({ passed: sum.passed + r.passed, total: sum.total + r.total }), { passed: 0, total: 0 })
const passedOnRetry = entries.filter((e) => e.passedOnRetry).map((e) => e.file)
console.log(`\nbare runner: ${files.length - hardFailures.length}/${files.length} file(s), ${tests.passed}/${tests.total} test(s) passed`)
if (passedOnRetry.length > 0) console.log(`passed only on retry: ${passedOnRetry.join(' ')}`)
if (hardFailures.length > 0) {
  console.log(`failed: ${hardFailures.join(' ')}`)
  process.exit(1)
}
