import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8')

// The defect this pins was never a wrong value: getDownloadConcurrency() read a key that main
// never put in the bootstrap frame and config.json never carried, so a shipped build always ran
// the hardcoded default and the documented rollback lever did not exist. Nothing fails when a knob
// is wired at one end only. The frame half is now driven directly in worker-host.test.js; what is
// checked here is the other two ends — the config default, and the worker reading the frame.
test('config.json defines the key the frame reads', (t) => {
  t.ok(/network: \{[^}]*\bdownloadConcurrency\b/.test(read('main/config-store.js')),
    'the network defaults carry downloadConcurrency')
})

test('the worker reads the frame into the runtime config', (t) => {
  const worker = read('worker/main.js')
  t.ok(/const bootstrap = await getBootstrapPromise\(\)\s*\n\s*setRuntimeConfig\(bootstrap\)/.test(worker),
    'the frame is handed to setRuntimeConfig verbatim')
  // buildConfig copies every key of DEFAULTED off the frame, so the value needs a default entry
  // to be carried at all — without it the frame key is silently dropped.
  t.ok(/\bdownloadConcurrency: \d+/.test(read('shared/core/runtime-config.js')),
    'runtime-config declares the key in DEFAULTED')
})
