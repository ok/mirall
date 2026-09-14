import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

// The BEHAVIOUR — one guarded write path, a bootstrap that must land, a write failure reported
// once, a dead worker's roots cleared — is asserted in worker-host.test.js, which drives the real
// module. What survives here is the one property no behavioural test can express: that the frame
// shape is spelled in exactly one place. A second `worker.write(Buffer.from(JSON.stringify(...)))`
// somewhere else would pass every behavioural test and still be a second framing to keep in step.
const here = path.dirname(fileURLToPath(import.meta.url))
const src = readFileSync(path.join(here, '..', '..', 'src', 'main', 'worker-host.js'), 'utf8')
const code = src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n')

function fnBody(name) {
  const m = code.match(new RegExp('function ' + name + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}'))
  return m ? m[1] : null
}

test('the worker frame shape is spelled in exactly one place', (t) => {
  const framings = code.match(/worker\.write\(Buffer\.from\(JSON\.stringify/g) ?? []
  t.is(framings.length, 1, 'one JSON+newline+Buffer framing')
  t.ok(/worker\.write\(Buffer\.from\(JSON\.stringify/.test(fnBody('sendToWorker')),
    'and it lives in sendToWorker, the writer that owns it')
})

test('only the renderer byte relay writes to a worker directly', (t) => {
  // The relay is the one legitimate exception: the renderer has already serialised its own NDJSON
  // envelope, so there is no frame object to hand over.
  const getWorker = code.slice(code.indexOf('function getWorker'), code.indexOf('\nfunction ', code.indexOf('function getWorker') + 1))
  const rawWrites = getWorker.match(/worker\.write\(/g) ?? []
  t.is(rawWrites.length, 1, 'exactly one direct worker.write() is left')
})
