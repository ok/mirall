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

test('no window writes to the spawn pipe', (t) => {
  // Windows reach the worker over their own socket connections; the spawn pipe carries main's frames
  // only, and every one of those goes through sendToWorker.
  const start = code.indexOf('function getWorker')
  t.ok(start >= 0, 'getWorker is where it is looked for')
  const getWorker = code.slice(start, code.indexOf('\nfunction ', start + 1))
  t.is((getWorker.match(/worker\.write\(/g) ?? []).length, 0, 'no direct worker.write() is left')
})
