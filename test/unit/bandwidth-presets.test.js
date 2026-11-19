import test from 'brittle'
import { MIN_KBPS, PRESET_KBPS, clampLimit, isPresetLimit, limitLabel } from '../../src/renderer/model/bandwidth-presets.js'
import { MIN_BYTES_PER_SECOND } from '../../src/shared/transfer/bandwidth-limiter.js'

test('the presets start at unlimited and rise', (t) => {
  t.is(PRESET_KBPS[0], 0, 'unlimited comes first')
  t.alike([...PRESET_KBPS].sort((a, b) => a - b), PRESET_KBPS, 'in rising order')
  for (const preset of PRESET_KBPS) t.ok(isPresetLimit(preset), `${preset} is a preset`)
  t.absent(isPresetLimit(200), 'a typed limit is not')
})

test('a limit is written in whole MB/s where it is one, in KB/s otherwise', (t) => {
  t.is(limitLabel(0, 'Unlimited'), 'Unlimited')
  t.is(limitLabel(1024, 'Unlimited'), '1 MB/s')
  t.is(limitLabel(25600, 'Unlimited'), '25 MB/s')
  t.is(limitLabel(200, 'Unlimited'), '200 KB/s')
  t.is(limitLabel(1500, 'Unlimited'), '1500 KB/s')
})

test('a typed limit is raised to the floor the worker enforces; zero stays unlimited', (t) => {
  t.is(MIN_KBPS * 1024, MIN_BYTES_PER_SECOND, 'the renderer and the worker share one floor')
  t.is(clampLimit(0), 0)
  t.is(clampLimit(8), MIN_KBPS)
  t.is(clampLimit(MIN_KBPS), MIN_KBPS)
  t.is(clampLimit(4000), 4000)
})
