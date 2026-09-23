import test from 'brittle'
import { readFileSync, readdirSync, statSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '..')

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = path.join(dir, name)
    if (statSync(p).isDirectory()) { if (name !== 'locales') walk(p, out) }
    else if (/\.(ts|tsx|js)$/.test(name)) out.push(p)
  }
  return out
}

const read = (rel) => readFileSync(path.join(root, rel), 'utf8')

// The worker holds a serve-detail subscription against the CONNECTION (files.js keys it by
// client.id and drops it on disconnect), so a new worker has never heard of it. One caller is what
// makes the re-arm a single line in one hook; a second caller is a second thing to remember, and
// the one that is forgotten streams nothing while its row stays expanded.
test('serving:detail-subscribe has exactly one renderer caller, and it re-arms', (t) => {
  const renderer = path.join(root, 'src', 'renderer')
  const callers = walk(renderer)
    .filter((f) => readFileSync(f, 'utf8').includes("'serving:detail-subscribe'"))
    .map((f) => path.relative(renderer, f).split(path.sep).join('/'))
  t.alike(callers, ['hooks/usePeerDownloadDetail.ts'])
  t.ok(read('src/renderer/hooks/usePeerDownloadDetail.ts').includes('onResync('), 'and it registers a re-arm')
})

// The closed list. A new handler that creates per-client worker state either re-arms, or says here
// why it does not.
const REARM = {
  'src/worker/ipc/files.js': 'src/renderer/hooks/usePeerDownloadDetail.ts',
  'src/worker/ipc/settings.js': 'src/renderer/screens/NetworkDiagnosticsScreen.tsx',
}
const EXEMPT = {
  'src/worker/ipc/folder-preview.js':
    'a preview dies with the worker and its request rejects; the modal reports that failure to the ' +
    'user, and silently restarting a multi-second scan behind a message that already said it failed ' +
    'is the worse end',
}

test('every worker registry keyed by client.id is re-armed, or exempt with a reason', (t) => {
  const writers = walk(path.join(root, 'src', 'worker', 'ipc'))
    .filter((f) => readFileSync(f, 'utf8').includes('onClientDisconnect'))
    .map((f) => path.relative(root, f).split(path.sep).join('/'))
  t.ok(writers.length > 0, 'the per-client registries were actually found')
  const unhandled = writers.filter((f) => {
    if (EXEMPT[f]) return false
    const rearm = REARM[f]
    return !rearm || !read(rearm).includes('onResync(')
  })
  t.alike(unhandled, [], 'a per-client worker registry with no renderer re-arm and no exemption')
})
