import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// main.js cannot be imported — it calls registerSchemesAsPrivileged at module scope — so these are
// asserted against its source, the way main-log-forwarding.test.js and worker-epipe-guard.test.js
// already do for the same reason.
const here = path.dirname(fileURLToPath(import.meta.url))
const mainSrc = readFileSync(path.join(here, '..', '..', 'src', 'main', 'main.js'), 'utf8')

function fnBody(name) {
  const m = mainSrc.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}'))
  return m ? m[1] : null
}

// Prose mentions worker.write() and worker.once('exit') by name in several places, and a bare
// substring search finds those first. Strip line comments before counting anything.
const code = (text) => text.split('\n').filter((line) => !line.trim().startsWith('//')).join('\n')

const getWorker = code(mainSrc.match(/function getWorker\s*\([\s\S]*?\n\}/)?.[0] ?? '')

test('REGRESSION (FIX-BOOTSTRAP-1): every frame main puts on the worker pipe is written through one guarded path', (t) => {
  // The bootstrap write was the only one of four with no try/catch. A worker that died between
  // pear.run() and the first write threw synchronously out of getWorker, out of the
  // pear:startWorker handler, and reached the renderer as a rejected invoke — with no bootstrap
  // ever sent and nothing saying why. The async EPIPE case was already covered by worker.on('error').
  t.ok(getWorker, 'getWorker() exists in src/main/main.js')

  t.ok(/sendToWorker\(worker,\s*bootstrap\)/.test(getWorker),
    'the bootstrap frame goes through sendToWorker')
  t.ok(/sendToWorker\(worker,\s*\{\s*type:\s*'shutdown'\s*\}\)/.test(getWorker),
    'and so does the shutdown frame')

  // The raw relay is the one legitimate exception: the renderer has already serialised its own
  // NDJSON envelope, so there is no frame object to hand over.
  const rawWrites = getWorker.match(/worker\.write\(/g) ?? []
  t.is(rawWrites.length, 1, 'exactly one direct worker.write() is left — the renderer byte relay')

  // The frame shape itself is spelled once, in the writer that owns it.
  const framings = code(mainSrc).match(/worker\.write\(Buffer\.from\(JSON\.stringify/g) ?? []
  t.is(framings.length, 1, 'the JSON+newline+Buffer shape is written in exactly one place')
  t.ok(/worker\.write\(Buffer\.from\(JSON\.stringify/.test(fnBody('sendToWorker')),
    'and that place is sendToWorker')
})

test('REGRESSION (FIX-BOOTSTRAP-2): a worker whose bootstrap never landed is not cached', (t) => {
  // Routing the bootstrap through a guarded writer nearly traded a loud failure for a silent one.
  // Before, the unguarded write threw out of getWorker and workers.set() never ran, so the next
  // startWorker retried. Swallowing it instead would cache a worker with no storage path, no
  // identity KEK and no feature flags — pear:startWorker returns true and every later renderer
  // request hangs against a process that can never answer.
  t.ok(/if\s*\(!sendToWorker\(worker,\s*bootstrap\)\)\s*\{/.test(getWorker),
    'the bootstrap write is checked, not fire-and-forget')

  const guard = getWorker.match(/if\s*\(!sendToWorker\(worker,\s*bootstrap\)\)\s*\{([\s\S]*?)\n  \}/)?.[1] ?? ''
  t.ok(/worker\.destroy\(\)/.test(guard), 'the half-started worker is torn down')
  t.ok(/throw new Error/.test(guard), 'and the failure reaches the caller')

  const guardAt = getWorker.indexOf('if (!sendToWorker(worker, bootstrap))')
  const cacheAt = getWorker.indexOf('workers.set(specifier, worker)')
  t.ok(guardAt >= 0 && cacheAt > guardAt, 'the guard runs before the worker is cached')
})

test('a failed frame write is only silent during a quit, and is reported once per worker', (t) => {
  // Outside a quit the frame was a watcher arming or a bootstrap that will never be retried, and
  // this line is the only thing that says it never left — behind the debug gate it never reaches a
  // release build's log ring. Once per worker, though: every frame after a pipe goes bad fails for
  // the same reason, and 2000 repeats would evict the crash that explains them from the ring.
  const body = fnBody('sendToWorker')
  t.ok(body, 'sendToWorker() exists')
  t.ok(/if\s*\(isQuitting\)/.test(body), 'the quit case is distinguished')
  t.ok(/console\.warn\('worker frame write failed:/.test(body),
    'and the non-quit case is reported without the debug gate')
  t.ok(/writeFailureReported\.has\(worker\)/.test(body) && /writeFailureReported\.add\(worker\)/.test(body),
    'the report is capped at one per worker')
  t.ok(/return true/.test(body) && /return false/.test(body),
    'and the caller can tell whether the frame went out')
})

test('REGRESSION (FIX-ROOTS-1): a dead worker\'s download roots stop authorising reveals', (t) => {
  // workerDownloadRoots is half of the shell:showInFolder allowlist. Nothing cleared it when the
  // worker exited, so the roots of a worker that had gone stayed revealable for the life of the
  // process.
  const onExit = mainSrc.match(/worker\.once\('exit',\s*\([\s\S]*?\n  \}\)/)?.[0] ?? ''
  t.ok(onExit, "the worker.once('exit') handler exists")
  t.ok(/workerDownloadRoots = \[\]/.test(onExit), 'the roots are dropped when the worker exits')
})
