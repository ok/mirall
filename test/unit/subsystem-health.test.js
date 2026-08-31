import test from 'brittle'
import { Subsystem, createLifecycle } from '../../src/shared/core/subsystem.js'

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }

class Plain extends Subsystem {}

class Talkative extends Subsystem {
  constructor (name, deps) { super(name, deps); this.wedged = false }
  health () { return { ok: !this.wedged, detail: this.wedged ? 'stuck' : null } }
}

// A subsystem returning its own `name` must not be able to shadow the row key the caller uses to
// identify it.
class Liar extends Subsystem {
  health () { return { ok: true, detail: null, name: 'something-else' } }
}

test('the default reports healthy while open and unhealthy once closing', async (t) => {
  const one = new Plain('one')
  await one.ready()
  t.alike(one.health(), { ok: true, detail: null })
  await one.close()
  t.is(one.health().ok, false, 'a closed subsystem is not healthy')
})

test('an override replaces the default verdict', async (t) => {
  const two = new Talkative('two')
  await two.ready()
  t.is(two.health().ok, true)
  two.wedged = true
  t.alike(two.health(), { ok: false, detail: 'stuck' })
})

test('the lifecycle reports every started subsystem and does not consume the list', async (t) => {
  const life = createLifecycle({ log: silentLog })
  await life.start(new Plain('a'))
  const b = await life.start(new Talkative('b'))

  t.alike(life.health().map((row) => row.name), ['a', 'b'], 'in start order')
  t.is(life.health().length, 2, 'reading health twice still reports both')

  b.wedged = true
  const rows = life.health()
  t.is(rows.find((row) => row.name === 'b').ok, false)
  t.is(rows.find((row) => row.name === 'a').ok, true, 'one unhealthy subsystem does not taint the rest')

  await life.close()
  t.alike(life.health(), [], 'a closed lifecycle reports nothing')
})

test('a subsystem cannot shadow the row key with its own name field', async (t) => {
  const life = createLifecycle({ log: silentLog })
  await life.start(new Liar('honest-name'))
  t.is(life.health()[0].name, 'honest-name')
  await life.close()
})

test('health does not throw for a subsystem whose open failed', async (t) => {
  class Broken extends Subsystem {
    async _open () { throw new Error('nope') }
  }
  const broken = new Broken('broken')
  await t.exception(broken.ready())
  t.is(broken.health().ok, false, 'a subsystem that never opened is not healthy')
})
