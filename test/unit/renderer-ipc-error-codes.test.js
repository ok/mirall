import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { CODES } from '../../src/shared/contract/errors.js'
import { ERROR_I18N_KEY_BY_CODE } from '../../src/renderer/errorMessages.js'
import { errorTextFor, FALLBACK_KEY } from '../../src/renderer/errorText.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..', '..')
const src = readFileSync(path.join(root, 'src', 'renderer', 'ipc.ts'), 'utf8')
const enErrors = JSON.parse(readFileSync(path.join(root, 'src', 'renderer', 'locales', 'en', 'errors.json'), 'utf8'))

const tr = (key) => 'T:' + key
const withCode = (message, code) => Object.assign(new Error(message), { code })

// src/renderer/ipc.ts reaches window.bridge and only runs inside Electron, so its wiring is pinned
// structurally — the renderer-cancellation-wiring.test.js pattern. The copy half below is driven
// through the real display boundary.

// REGRESSION (FIX-IPCCODE-1: a request that timed out, and one rejected because the worker was
// gone, carried no .code. errorTextFor keys on .code, so every one of them rendered the generic
// "Something went wrong" sentence — indistinguishable from an unrelated failure.)
test('REGRESSION (FIX-IPCCODE-1): a timed-out request carries the timeout code', (t) => {
  const timer = src.slice(src.indexOf('const timer = timeout > 0'), src.indexOf('function onAbort'))
  t.ok(/codedError\(`IPC timeout: \$\{type\} \(\$\{timeout\}ms\)`, CODES\.TIMEOUT\)/.test(timer),
    'the timeout rejects with CODES.TIMEOUT, not a bare Error')
})

test('REGRESSION (FIX-IPCCODE-1): a request with no worker behind it carries the worker code', (t) => {
  t.ok(src.includes("failAllPending('Worker exited with code ' + code, CODES.WORKER_UNAVAILABLE)"),
    'in-flight requests killed by a worker exit are coded')
  t.ok(/throw codedError\('Worker is unavailable \(respawn limit reached\)', CODES\.WORKER_UNAVAILABLE\)/.test(src),
    'and so is the fail-fast after the respawn policy gives up')
  const write = src.slice(src.indexOf('window.bridge.writeWorkerIPC(WORKER_SPEC, encoder.encode(envelope))'))
  t.ok(/CODES\.WORKER_UNAVAILABLE/.test(write), 'and a failed write to a worker that never spawned')
})

test('both codes are declared in the contract', (t) => {
  t.is(CODES.TIMEOUT, 'TIMEOUT')
  t.is(CODES.WORKER_UNAVAILABLE, 'WORKER_UNAVAILABLE')
})

test('REGRESSION (FIX-IPCCODE-1): each code renders its own sentence, not the generic one', (t) => {
  const timeout = errorTextFor(withCode('IPC timeout: share:list (30000ms)', CODES.TIMEOUT), tr)
  const gone = errorTextFor(withCode('Worker exited with code 1', CODES.WORKER_UNAVAILABLE), tr)
  t.not(timeout, 'T:' + FALLBACK_KEY, 'a timeout is diagnosable in the UI')
  t.not(gone, 'T:' + FALLBACK_KEY, 'so is a dead worker')
  t.not(timeout, gone, 'and the two read differently')
  t.is(timeout, 'T:' + ERROR_I18N_KEY_BY_CODE.TIMEOUT)
  t.is(gone, 'T:' + ERROR_I18N_KEY_BY_CODE.WORKER_UNAVAILABLE)
})

// The message these errors carry is written for a log; only the code becomes text a person reads.
test('neither sentence exposes the internal message', (t) => {
  for (const key of [ERROR_I18N_KEY_BY_CODE.TIMEOUT, ERROR_I18N_KEY_BY_CODE.WORKER_UNAVAILABLE]) {
    t.ok(Object.hasOwn(enErrors, key), `errors.${key} exists`)
    t.absent(/\bIPC\b|worker|\d+ms/i.test(enErrors[key]), `errors.${key} is user language, not wire detail`)
  }
})
