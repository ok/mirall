import test from 'brittle'
import { exceedsShareFileLimit } from '../../src/shared/folders/share-limits.js'
import { getMaxFilesPerShare, getListFilesCap, getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'

// The admission gate behind the add-folder wizard: a folder with more files than a share may hold
// is refused up front, instead of being accepted and then silently listed short.
test('exceedsShareFileLimit is exclusive at the boundary', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  setRuntimeConfig({ ...saved, maxFilesPerShare: 5000 })
  t.absent(exceedsShareFileLimit(4999))
  t.absent(exceedsShareFileLimit(5000), 'exactly at the limit is ADMITTED')
  t.ok(exceedsShareFileLimit(5001), 'one over is refused')
})

test('an explicit 0 / Infinity disables the gate', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  setRuntimeConfig({ ...saved, maxFilesPerShare: 0 })
  t.is(getMaxFilesPerShare(), Infinity, '0 → uncapped (Infinity, comparable)')
  t.absent(exceedsShareFileLimit(150000), 'nothing exceeds a disabled gate')

  setRuntimeConfig({ ...saved, maxFilesPerShare: Infinity })
  t.is(getMaxFilesPerShare(), Infinity)
})

// A protective gate must fail SAFE: a malformed value falls back to the default rather than
// silently admitting an unbounded folder — the same contract getListFilesCap holds.
test('getMaxFilesPerShare fails safe to the default on a malformed value', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  for (const bad of [-1, NaN, 'lots', null, undefined, {}]) {
    setRuntimeConfig({ ...saved, maxFilesPerShare: bad })
    t.is(getMaxFilesPerShare(), 5000, `${String(bad)} → default (the gate stays ON, not disabled)`)
  }
})

// The consistency contract the whole feature rests on: a folder the gate ADMITS must always render
// in full. If these two numbers ever drift apart, an admitted folder could be silently truncated —
// which is the exact bug this work exists to remove.
test('the admission limit and the display ceiling are the same number', (t) => {
  const saved = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(saved))

  setRuntimeConfig({})
  t.is(getMaxFilesPerShare(), getListFilesCap(), 'maxFilesPerShare === listFilesCap by default')
})

