// The sampler + last-seen pair behind the two peer-download tiers (src/renderer/hooks/useSpeedTracker.ts).
// The invariant worth a test is that the two halves are never half-forgotten: a row dropped from
// one map and left in the other reports a speed for a row that is gone, or no speed for one that is.
import test from 'brittle'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { transformSync } from 'esbuild'

const root = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// `useRef` is the only React the module touches, and a plain box is exactly what it is outside a
// render. The real speedSampler is loaded, since the speeds are the point.
function loadTracker() {
  const stubs = {
    react: { useRef: (initial) => ({ current: initial }) },
    '../speedSampler.js': null,
  }
  const sampler = readFileSync(join(root, 'src/renderer/speedSampler.js'), 'utf8')
  const samplerMod = { exports: {} }
  new Function('module', 'exports', transformSync(sampler, { loader: 'js', format: 'cjs' }).code)(samplerMod, samplerMod.exports)
  stubs['../speedSampler.js'] = samplerMod.exports

  const src = readFileSync(join(root, 'src/renderer/hooks/useSpeedTracker.ts'), 'utf8')
  const mod = { exports: {} }
  new Function('module', 'exports', 'require', transformSync(src, { loader: 'ts', format: 'cjs' }).code)(
    mod, mod.exports, (id) => stubs[id],
  )
  return mod.exports.useSpeedTracker()
}

test('a row is forgotten from both halves at once', (t) => {
  const speed = loadTracker()
  const now = 1_000_000
  speed.observe('a', now, 100)
  speed.observe('b', now, 100)
  t.ok(speed.seen('a') && speed.seen('b'), 'both rows are known')

  speed.forget('a')
  t.absent(speed.seen('a'), 'forgotten row is no longer seen')
  t.is(speed.decay('a', now + 1000, 500), 0, 'and decays to a standstill, not to its last speed')
  t.ok(speed.seen('b'), 'its neighbour is untouched')
})

test('retain drops every row outside the authoritative set', (t) => {
  const speed = loadTracker()
  const now = 1_000_000
  for (const key of ['a', 'b', 'c']) speed.observe(key, now, 10)
  speed.retain(new Set(['b']))
  t.absent(speed.seen('a'), 'a is gone')
  t.ok(speed.seen('b'), 'b is kept')
  t.absent(speed.seen('c'), 'c is gone')
})

test('expiry is measured from the last sighting, not from the first', (t) => {
  const speed = loadTracker()
  const start = 1_000_000
  speed.observe('a', start, 10)
  t.ok(speed.expired('a', start + 5001, 5000), 'silent past the ttl')
  speed.observe('a', start + 4000, 20)
  t.absent(speed.expired('a', start + 5001, 5000), 'a fresh sighting resets the clock')
  t.ok(speed.expired('never-seen', start, 5000), 'a row never seen is expired, not immortal')
})

test('observe reports a speed and reset clears everything', (t) => {
  const speed = loadTracker()
  const start = 1_000_000
  t.is(speed.observe('a', start, 0), 0, 'one sample is not yet a speed')
  const moving = speed.observe('a', start + 1000, 1000)
  t.ok(moving > 0, `two samples a second apart report a speed (${moving})`)
  speed.reset()
  t.absent(speed.seen('a'), 'reset forgets the row')
})
