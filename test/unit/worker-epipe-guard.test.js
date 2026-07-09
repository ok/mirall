import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// The real crash — an Electron "Uncaught Exception: write EPIPE" dialog —
// only manifests in the running app: teardown (e.g. a failed frontend test)
// races a write to the dead worker's sidecar pipe (the before-quit shutdown
// frame, a relayed renderer frame, a watcher event), and the EPIPE arrives
// asynchronously as a stream 'error' event that no try/catch around
// worker.write() can see. bare-sidecar reacts by destroy(err)ing the worker
// Duplex, which re-emits 'error' — and an 'error' emit with no listener
// throws, surfacing as the uncaught-exception dialog. There is no in-process
// surface to reproduce that chain from a unit test (no Electron, no Bare
// child here), so this test pins the structural invariant instead:
// getWorker() must attach a worker.on('error', …) listener in the same
// synchronous block that spawns the worker, so the async EPIPE is consumed.

const here = path.dirname(fileURLToPath(import.meta.url))
const mainSrc = readFileSync(path.join(here, '..', '..', 'src', 'main', 'main.js'), 'utf8')

function getWorkerBody() {
  const m = mainSrc.match(/function getWorker\s*\([\s\S]*?\n\}/)
  return m ? m[0] : null
}

test("REGRESSION (FIX-EPIPE-1: uncaught 'write EPIPE' dialog when a write races worker death): getWorker consumes worker stream 'error'", (t) => {
  const body = getWorkerBody()
  t.ok(body, 'getWorker() exists in src/main/main.js')
  t.ok(/worker\.on\(\s*['"]error['"]/.test(body || ''), "getWorker attaches worker.on('error', …)")
})
