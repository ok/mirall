import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { getDownloadConcurrency, getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

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
  t.ok(/const bootstrap = await ipc\.bootstrapPromise\s*\n\s*setRuntimeConfig\(bootstrap\)/.test(worker),
    'the frame is handed to setRuntimeConfig verbatim')
  // buildConfig copies every tabled key off the frame, so the value needs a schema row to be
  // carried at all — without it the frame key is silently dropped.
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))
  setRuntimeConfig({ downloadConcurrency: 3 })
  t.is(getDownloadConcurrency(), 3, 'the frame value reaches the getter')
})
