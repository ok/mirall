import test from 'brittle'
import { getListFilesCap, getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// The share:list-files row cap that keeps a 150k-file folder from materialising a giant
// row array (+ IPC frame) per refresh. 0 / Infinity is the "disable the cap" escape hatch.
test('getListFilesCap honours the runtime-config knob; 0 disables it', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  t.is(getListFilesCap(), 5000, 'default cap')
  setRuntimeConfig({ ...saved, listFilesCap: 10 })
  t.is(getListFilesCap(), 10, 'override honoured')
  setRuntimeConfig({ ...saved, listFilesCap: 0 })
  t.is(getListFilesCap(), Infinity, '0 → uncapped (Infinity, comparable)')
  setRuntimeConfig({ ...saved, listFilesCap: Infinity })
  t.is(getListFilesCap(), Infinity, 'Infinity → uncapped')
})

// A protective bound must fail SAFE: a malformed value must fall back to the default, never
// silently disable the cap (which would reopen the OOM this knob exists to prevent).
test('getListFilesCap fails safe to the default on a malformed value', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  for (const bad of [-1, NaN, '5000', null, undefined]) {
    setRuntimeConfig({ ...saved, listFilesCap: bad })
    t.is(getListFilesCap(), 5000, `${String(bad)} → default cap (not unbounded)`)
  }
})
