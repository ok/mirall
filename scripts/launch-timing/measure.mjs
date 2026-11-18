// Launch time of an installed Mirall build, and the release gate that compares two builds' runs.
//
//   node scripts/launch-timing/measure.mjs run --app <Mirall.app | executable> --label <name> --storage <data folder copy>
//   node scripts/launch-timing/measure.mjs compare <baseline.json> <candidate.json>
//
// `run` launches the app N times on one data folder, records per launch the milliseconds from
// process start to the back end reporting ready and to the spaces list showing (marks.mjs), quits
// it and confirms every process it started is gone before the next launch. It never launches on
// the app's default data folder: the folder is a copy the person made, passed with --storage,
// which the app honours in a packaged build. `--source <repo>` launches a source checkout instead,
// for trying the script itself. `compare` applies the gate in launch-stats.mjs and exits 1 when it
// blocks.
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, realpathSync, statSync, writeFileSync } from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { MARKS, compareResults, seriesOf, summarize } from './launch-stats.mjs'
import { backendSocketPath, devtoolsUrlIn, now, socketAnswers, watchBackend, watchSpacesShown } from './marks.mjs'
import { descendantsOf, forceKill, listProcesses, requestQuit, resolveLaunch, stillRunning } from './app-process.mjs'
import { defaultDataDir } from '../../src/shared/core/default-data-dir.js'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const PROCESS_POLL_MS = 250
const STDERR_TAIL_LINES = 60

/** The one launch in flight, so an interrupted run still ends the app it started. */
let inFlight = null

function usage(message) {
  if (message) console.error(message)
  console.error([
    'usage:',
    '  measure.mjs run (--app <path> | --source <repo>) --label <name> --storage <dir>',
    '                  [--runs 10] [--timeout 120] [--quit-timeout 30] [--pause 3] [--out <file>]',
    '  measure.mjs compare <baseline.json> <candidate.json>',
  ].join('\n'))
  process.exit(2)
}

// The default data folder is the person's real profile; the measurement only ever runs on a copy.
function refuseRealProfile(storage) {
  const real = defaultDataDir({ platform: process.platform, env: process.env, homedir: os.homedir(), productName: 'Mirall' })
  const resolve = (p) => { try { return realpathSync(p) } catch { return path.resolve(p) } }
  if (resolve(storage) === resolve(real)) usage(`refusing to launch on the default data folder ${real}; pass a copy`)
  if (!existsSync(path.join(storage, 'app-storage'))) {
    usage(`${storage} holds no app-storage folder; pass a copy of a data folder with a profile and at least one space`)
  }
}

function devtoolsFromPortFile(storage, since) {
  const file = path.join(storage, 'DevToolsActivePort')
  try {
    if (statSync(file).mtimeMs < since) return null
    const [port, wsPath] = readFileSync(file, 'utf8').split(/\r?\n/)
    return port && wsPath ? `ws://127.0.0.1:${port}${wsPath}` : null
  } catch {
    return null
  }
}

async function waitForDevtools(state, storage, t0, deadline) {
  const fromStartWall = Date.now() - (now() - t0)
  while (now() < deadline) {
    const url = state.devtoolsUrl ?? devtoolsFromPortFile(storage, fromStartWall)
    if (url) return url
    if (state.exited) throw new Error('the app exited before opening its DevTools endpoint')
    await sleep(20)
  }
  throw new Error('the app printed no DevTools endpoint; this build may refuse --remote-debugging-port')
}

function startApp(launch, storage) {
  const state = { devtoolsUrl: null, exited: false, tail: [] }
  // The app's own flags come first: its argv parser stops at the first flag it does not know, and
  // Chromium reads its switch from anywhere on the line.
  const args = [...launch.prefix, '--no-updates', '--storage', storage, '--remote-debugging-port=0']
  const child = spawn(launch.file, args, {
    detached: process.platform !== 'win32',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, MIRALL_NO_DEVTOOLS: '1' },
  })
  const keep = (chunk) => {
    for (const line of String(chunk).split(/\r?\n/)) {
      if (!line) continue
      state.devtoolsUrl ??= devtoolsUrlIn(line)
      state.tail.push(line)
      if (state.tail.length > STDERR_TAIL_LINES) state.tail.shift()
    }
  }
  child.stdout.on('data', keep)
  child.stderr.on('data', keep)
  child.once('exit', () => { state.exited = true })
  return { child, state }
}

// Waits for every process the launch started, the back end included, to be gone. A quit that does
// not finish in time is forced and the run says so; one that leaves a process even then stops the
// series, because the next launch would meet it.
async function quitAndConfirm({ child, socketPath, quitTimeoutMs }) {
  const tree = descendantsOf(await listProcesses(), child.pid)
  const started = now()
  await requestQuit(child.pid)
  let forced = false
  let left = tree
  while ((left = await stillRunning(left)).length) {
    if (now() - started > quitTimeoutMs) {
      if (forced) throw new Error(`processes still running after a forced quit: ${left.join(', ')}`)
      forced = true
      await forceKill(left)
    }
    await sleep(PROCESS_POLL_MS)
  }
  if (await socketAnswers(socketPath)) throw new Error(`the back end socket still answers after quit: ${socketPath}`)
  return { quitMs: Math.round(now() - started), forced, processes: tree.length }
}

async function launchOnce({ launch, storage, socketPath, timeoutMs, quitTimeoutMs }) {
  if (await socketAnswers(socketPath)) throw new Error(`a back end already serves this data folder (${socketPath}); quit it first`)
  const t0 = now()
  const deadline = t0 + timeoutMs
  const { child, state } = startApp(launch, storage)
  inFlight = { child, socketPath, quitTimeoutMs }
  let backend, shown
  try {
    [backend, shown] = await Promise.all([
      watchBackend(socketPath, { deadline }),
      waitForDevtools(state, storage, t0, deadline).then((url) => watchSpacesShown(url, { deadline })),
    ])
  } catch (err) {
    inFlight = null
    err.tail = state.tail
    await quitAndConfirm({ child, socketPath, quitTimeoutMs }).catch((quitErr) => { err.message += `; ${quitErr.message}` })
    throw err
  }
  inFlight = null
  const quit = await quitAndConfirm({ child, socketPath, quitTimeoutMs })
  const ms = (at) => (at === null ? null : Math.round(at - t0))
  return {
    marks: { backendReady: ms(backend.readyAt), spacesShown: ms(shown.shownAt) },
    detail: {
      socketMs: ms(backend.socketAt),
      workerReadyMs: ms(backend.workerReadyAt),
      readyEvent: backend.readyEvent,
      spacesLate: shown.late,
      appVersion: backend.appVersion,
    },
    quit,
  }
}

function readOptions(argv) {
  const { values } = parseArgs({
    args: argv,
    options: {
      app: { type: 'string' },
      source: { type: 'string' },
      label: { type: 'string' },
      storage: { type: 'string' },
      runs: { type: 'string', default: '10' },
      timeout: { type: 'string', default: '120' },
      'quit-timeout': { type: 'string', default: '30' },
      pause: { type: 'string', default: '3' },
      out: { type: 'string' },
    },
  })
  if (!values.app === !values.source) usage('pass exactly one of --app and --source')
  if (!values.label) usage('--label is required')
  if (!values.storage) usage('--storage is required')
  const storage = path.resolve(values.storage)
  refuseRealProfile(storage)
  const number = (name) => {
    const n = Number(values[name])
    if (!(n > 0)) usage(`--${name} must be a positive number`)
    return n
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  return {
    target: { app: values.app, source: values.source },
    label: values.label,
    storage,
    runs: Math.round(number('runs')),
    timeoutMs: number('timeout') * 1000,
    quitTimeoutMs: number('quit-timeout') * 1000,
    pauseMs: number('pause') * 1000,
    out: path.resolve(values.out ?? `launch-${values.label}-${process.platform}-${stamp}.json`),
  }
}

function summaryOf(runs) {
  const series = seriesOf(runs)
  return Object.fromEntries(MARKS.filter((m) => series[m].length).map((m) => [m, summarize(series[m])]))
}

function writeResults(opts, launch, runs, error) {
  const results = {
    label: opts.label,
    app: opts.target.app ? path.resolve(opts.target.app) : null,
    source: opts.target.source ? path.resolve(opts.target.source) : null,
    executable: launch.file,
    storage: opts.storage,
    platform: process.platform,
    arch: process.arch,
    osRelease: os.release(),
    node: process.version,
    measuredAt: new Date().toISOString(),
    error: error ?? null,
    runs,
    summary: summaryOf(runs),
  }
  writeFileSync(opts.out, JSON.stringify(results, null, 2) + '\n')
}

async function runCommand(argv) {
  const opts = readOptions(argv)
  const launch = resolveLaunch(opts.target)
  const socketPath = backendSocketPath(opts.storage)
  const runs = []
  console.log(`${opts.label}: ${opts.runs} launches of ${launch.file} on ${opts.storage}`)
  for (let i = 1; i <= opts.runs; i++) {
    try {
      const result = await launchOnce({ launch, storage: opts.storage, socketPath, timeoutMs: opts.timeoutMs, quitTimeoutMs: opts.quitTimeoutMs })
      runs.push({ run: i, ...result })
      console.log(`  run ${i}: back end ready ${result.marks.backendReady} ms, spaces shown ${result.marks.spacesShown} ms` +
        `${result.detail.spacesLate ? ' (list was up before the watch: an upper bound)' : ''}` +
        `${result.quit.forced ? ' (quit was forced)' : ''}`)
    } catch (err) {
      console.error(`  run ${i} failed: ${err.message}`)
      if (err.tail?.length) console.error('  last app output:\n    ' + err.tail.join('\n    '))
      writeResults(opts, launch, runs, `run ${i}: ${err.message}`)
      console.error(`partial results: ${opts.out}`)
      process.exit(1)
    }
    if (i < opts.runs) await sleep(opts.pauseMs)
  }
  writeResults(opts, launch, runs, null)
  for (const [mark, s] of Object.entries(summaryOf(runs))) {
    console.log(`${mark}: median ${s.median.toFixed(0)} ms, IQR ${s.iqr.toFixed(0)} ms (min ${s.min}, max ${s.max})`)
  }
  console.log(`results: ${opts.out}`)
}

function compareCommand([baselineFile, candidateFile]) {
  if (!baselineFile || !candidateFile) usage('compare needs two result files')
  const baseline = JSON.parse(readFileSync(baselineFile, 'utf8'))
  const candidate = JSON.parse(readFileSync(candidateFile, 'utf8'))
  const verdict = compareResults(baseline, candidate)
  if (verdict.refused) {
    console.error(`cannot compare: ${verdict.refused}`)
    process.exit(2)
  }
  console.log(`baseline ${baseline.label} vs candidate ${candidate.label} on ${baseline.platform}`)
  for (const [mark, v] of Object.entries(verdict.marks)) {
    console.log(`${mark}: median ${v.baseline.median.toFixed(0)} -> ${v.candidate.median.toFixed(0)} ms ` +
      `(${v.delta >= 0 ? '+' : ''}${v.delta.toFixed(0)} ms, allowed +${v.allowed.toFixed(0)} ms; ` +
      `IQR ${v.baseline.iqr.toFixed(0)} / ${v.candidate.iqr.toFixed(0)} ms) ${v.blocked ? 'BLOCKED' : 'ok'}`)
  }
  console.log(verdict.blocked ? 'verdict: the cut is blocked' : 'verdict: within the gate')
  process.exit(verdict.blocked ? 1 : 0)
}

async function endInFlight() {
  if (!inFlight) return
  const { child, socketPath, quitTimeoutMs } = inFlight
  inFlight = null
  await quitAndConfirm({ child, socketPath, quitTimeoutMs }).catch((err) => console.error(err.message))
}

process.on('SIGINT', () => { endInFlight().finally(() => process.exit(130)) })

const [command, ...rest] = process.argv.slice(2)
if (command === 'run') await runCommand(rest)
else if (command === 'compare') compareCommand(rest)
else usage()
