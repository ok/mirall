import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', '..', 'src', 'renderer', 'ipc.ts'), 'utf8')

// src/renderer/ipc.ts reaches window.bridge and only runs inside Electron, so its wiring is pinned
// structurally — the renderer-reconcile-subscriptions.test.js pattern. The behaviour these
// properties produce is asserted where it can be: query-store.test.js drives the only production
// caller that passes a signal, and ipc-cancellation.test.js drives the worker end of the frame.

test('request() takes a signal and turns an abort into a cancel frame', (t) => {
  t.ok(/opts:\s*RequestOptions/.test(src), 'the option is typed, not a loose bag')
  t.ok(src.includes('FRAME.CANCEL'), 'the abort writes the contract control frame')
  t.ok(/void window\.bridge\.writeWorkerIPC\(WORKER_SPEC, encoder\.encode\(frame\)\)/.test(src),
    'fire-and-forget: the local rejection does not wait for an ack it has no use for')
})

// A listener attached to an ALREADY-aborted AbortSignal never fires. request() awaits the worker
// ready-gate before it attaches one, so without a re-check an abort landing during that wait would
// be lost and the request would run to completion with nobody left to receive it.
test('an abort during the worker-ready wait is not lost', (t) => {
  const executor = src.slice(src.indexOf('const id = nextId++'))
  const recheck = executor.indexOf('if (signal?.aborted)')
  const attach = executor.indexOf("addEventListener('abort'")
  t.ok(recheck !== -1, 'the executor re-checks the signal')
  t.ok(recheck < attach, 'and it does so BEFORE attaching the listener that could not fire')
  t.ok(src.indexOf('if (opts.signal?.aborted) throw cancelledError(type)') !== -1,
    'plus the entry check, so an already-aborted caller never waits on a respawn')
})

// One signal is reused across many reads (one per screen), so a listener left behind on every
// settled request accumulates for the life of that signal.
test('the abort listener is detached on every settle path', (t) => {
  const executor = src.slice(src.indexOf('const id = nextId++'))
  const detaches = (executor.match(/detach\(\)/g) || []).length
  t.ok(detaches >= 5, `detach() on resolve, reject, timeout, abort and write-failure (found ${detaches})`)
  t.ok(/removeEventListener\('abort', onAbort\)/.test(src), 'and it removes the listener it added')
})

test('the cancel frame carries the request id and nothing else', (t) => {
  t.ok(/JSON\.stringify\(\{ type: FRAME\.CANCEL, id \}\)/.test(src),
    'a control frame is not a request: no args, no handler, no response expected')
})
