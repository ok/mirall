import test from 'brittle'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import path from 'path'
import { getDownloadConcurrency, getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { defaultSettings, settingsToRuntimeConfig } from '../../src/shared/core/settings-rules.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const read = (rel) => readFileSync(path.join(here, '..', '..', 'src', rel), 'utf8')

// The defect this pins was never a wrong value: getDownloadConcurrency() read a key no persisted
// settings carried, so a shipped build always ran the hardcoded default and the documented rollback
// lever did not exist. Nothing fails when a knob is wired at one end only, so every end is pinned:
// the settings default, the projection onto the runtime-config key, and the worker handing the
// assembled config over whole.
test('settings.json defines the key the runtime config reads', (t) => {
  t.is(defaultSettings().network.downloadConcurrency, 6, 'the network defaults carry downloadConcurrency')
  t.is(settingsToRuntimeConfig(defaultSettings()).downloadConcurrency, 6, 'and the projection carries it over')
})

test('the worker assembles the frame, its settings and its flags into the runtime config', (t) => {
  const worker = read('worker/main.js')
  // Adjacency is not the rule — the await sits in a try/catch so a refused protocol version can
  // exit with its own code. The rule is that nothing reads a field off the frame before the whole
  // frame reaches the assembly: a field pulled out here is one the config never learns about.
  const awaited = worker.indexOf('bootstrap = await ipc.bootstrapPromise')
  const handed = worker.indexOf('setRuntimeConfig(assembleRuntimeConfig({ bootstrap, settings: getSettings(), flags }))')
  t.ok(awaited !== -1 && handed > awaited, 'the frame is awaited whole, then assembled into the config')
  const between = worker.slice(awaited, handed)
  t.alike(between.match(/\bbootstrap\.\w+/g), ['bootstrap.featureFlags', 'bootstrap.storage'],
    'only the flag override and the storage path are read off it first — the two the other sources need')
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))
  setRuntimeConfig({ downloadConcurrency: 3 })
  t.is(getDownloadConcurrency(), 3, 'the assembled value reaches the getter')
})
