import test from 'brittle'
import { Subsystem, createLifecycle } from '../../src/shared/core/subsystem.js'
import { Supervisor } from '../../src/shared/core/supervisor.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }
const quiet = (subsystem) => { subsystem.log = silentLog; return subsystem }

class Wedgeable extends Subsystem {
  constructor (name, units = [{ key: 'u1', ok: true, detail: null }]) {
    super(name)
    this.units = units
    this.recovered = []
    quiet(this)
  }

  supervise () { return this.units }
  async recover (key) { this.recovered.push(key) }
  wedge (key = 'u1') { this.units = [{ key, ok: false, detail: 'stuck' }] }
  heal (key = 'u1') { this.units = [{ key, ok: true, detail: null }] }
}

async function harness (t, subsystems) {
  const life = createLifecycle({ log: silentLog })
  for (const subsystem of subsystems) await life.start(subsystem)
  const supervisor = quiet(await life.start(new Supervisor('supervision', { lifecycle: life })))
  t.teardown(() => life.close())
  return { life, supervisor }
}

test('a subsystem with no supervisable units is never probed', async (t) => {
  class Silent extends Subsystem {}
  const { supervisor } = await harness(t, [quiet(new Silent('silent'))])
  await supervisor.probe()
  t.alike(supervisor.collectRows(), [], 'nothing to supervise')
  t.alike(supervisor.stats().recoveries, {})
})

test('a unit is recovered only after two consecutive bad probes', async (t) => {
  const mirrors = new Wedgeable('mirrors')
  const { supervisor } = await harness(t, [mirrors])
  mirrors.wedge()

  await supervisor.probe()
  t.alike(mirrors.recovered, [], 'one bad probe is not enough to act')
  await supervisor.probe()
  t.alike(mirrors.recovered, ['u1'])
  t.is(supervisor.stats().recoveries.mirrors, 1)
})

test('a healthy unit is never recovered', async (t) => {
  const mirrors = new Wedgeable('mirrors')
  const { supervisor } = await harness(t, [mirrors])
  await supervisor.probe()
  await supervisor.probe()
  await supervisor.probe()
  t.alike(mirrors.recovered, [])
})

test('a subsystem whose supervise() throws does not blind the supervisor to the rest', async (t) => {
  class Broken extends Subsystem {
    supervise () { throw new Error('nope') }
  }
  const mirrors = new Wedgeable('mirrors')
  const { supervisor } = await harness(t, [quiet(new Broken('broken')), mirrors])
  mirrors.wedge()

  await supervisor.probe()
  await supervisor.probe()
  t.alike(mirrors.recovered, ['u1'], 'the healthy reporter is still supervised')
})

test('a recovery that throws does not stop the probe', async (t) => {
  class Failing extends Wedgeable {
    async recover () { throw new Error('cannot') }
  }
  const failing = new Failing('failing')
  const mirrors = new Wedgeable('mirrors')
  const { supervisor } = await harness(t, [failing, mirrors])
  failing.wedge()
  mirrors.wedge()

  await supervisor.probe()
  await supervisor.probe()
  t.alike(mirrors.recovered, ['u1'], 'the second subsystem was still reached')
})

test('pause() stops acting even though the lifecycle still looks healthy', async (t) => {
  const mirrors = new Wedgeable('mirrors')
  const { supervisor } = await harness(t, [mirrors])
  mirrors.wedge()

  await supervisor.probe()
  supervisor.pause()
  await supervisor.probe()
  await supervisor.probe()
  t.alike(mirrors.recovered, [], 'the shutdown window is covered before any stopping flag is set')
})

test('a subsystem already stopping is skipped', async (t) => {
  const mirrors = new Wedgeable('mirrors')
  const { supervisor } = await harness(t, [mirrors])
  mirrors.wedge()
  await supervisor.probe()
  mirrors._stopping = true
  await supervisor.probe()
  t.alike(mirrors.recovered, [])
})

test('a shutdown beginning between two units stops the second recovery', async (t) => {
  const first = new Wedgeable('first')
  const second = new Wedgeable('second')
  const { supervisor } = await harness(t, [first, second])
  first.wedge()
  second.wedge()
  first.recover = async (key) => { first.recovered.push(key); supervisor.pause() }

  await supervisor.probe()
  await supervisor.probe()
  t.alike(first.recovered, ['u1'])
  t.alike(second.recovered, [], 'an entry-only guard would have recovered this one too')
})

test('a probe overlapping a slow recovery is skipped, not queued', async (t) => {
  const mirrors = new Wedgeable('mirrors')
  const { supervisor } = await harness(t, [mirrors])
  mirrors.wedge()
  await supervisor.probe()

  let release = null
  mirrors.recover = async (key) => {
    mirrors.recovered.push(key)
    await new Promise((resolve) => { release = resolve })
  }
  const slow = supervisor.probe()
  await supervisor.probe()
  await supervisor.probe()
  release()
  await slow
  t.alike(mirrors.recovered, ['u1'], 'the re-entrant probes did nothing')
})

test('the supervisor does not supervise itself', async (t) => {
  const { supervisor } = await harness(t, [])
  supervisor.supervise = () => [{ key: 'self', ok: false, detail: 'stuck' }]
  await supervisor.probe()
  await supervisor.probe()
  t.alike(supervisor.stats().recoveries, {})
})

test('stats() reports counts by subsystem and never a unit key', async (t) => {
  const mirrors = new Wedgeable('mirrors', [{ key: 'space-abc/share-def', ok: false, detail: 'stuck' }])
  const { supervisor } = await harness(t, [mirrors])
  await supervisor.probe()
  await supervisor.probe()

  const serialised = JSON.stringify(supervisor.stats())
  t.is(supervisor.stats().recoveries.mirrors, 1)
  t.absent(serialised.includes('space-abc'), 'no space id reaches the shareable bundle')
  t.absent(serialised.includes('share-def'), 'no share id either')
})

// The supervisor is started LAST so the lifecycle's reverse close order stops it FIRST. That
// ordering is the whole guard: a probe interval outliving the subsystems it supervises would
// recover work a shutdown has already stopped.
test('REGRESSION (SUP-1): the supervisor closes first and leaves no probe armed', async (t) => {
  setRuntimeConfig({ ...getRuntimeConfig(), supervisionProbeIntervalMs: 20 })
  const closed = []
  class Recorder extends Subsystem {
    async _close () { closed.push(this.name) }
  }
  const life = createLifecycle({ log: silentLog })
  await life.start(quiet(new Recorder('mirrors')))
  await life.start(quiet(new Recorder('sweeps')))
  const supervisor = quiet(await life.start(new Supervisor('supervision', { lifecycle: life })))
  supervisor.on('close', () => closed.push(supervisor.name))
  t.is(supervisor.timers.size, 1, 'the probe interval is armed while open')

  await life.close()
  t.alike(closed, ['supervision', 'sweeps', 'mirrors'], 'stopped before anything it supervises')
  t.is(supervisor.timers.size, 0, 'and its probe interval is gone')
  t.ok(supervisor.timers.closed, 'with the timer set closed, so nothing can re-arm one')
})

// REGRESSION (FIX-RECOVER-BUDGET: probe() held `probing` across a bare `await recover()`. The base
// contract permits a recovery that never settles, and one of those ended supervision for every
// other unit for the rest of the process — silently, because the Supervisor overrode no health().)
test('REGRESSION (FIX-RECOVER-BUDGET): a recovery that does not return is abandoned', async (t) => {
  const before = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(before))
  setRuntimeConfig({ ...before, supervisionRecoverBudgetMs: 20, supervisionProbeIntervalMs: 3_600_000 })

  class Hangs extends Subsystem {
    supervise () { return [{ key: 'u1', ok: false, detail: 'stuck' }] }
    recover () { return new Promise(() => {}) }
  }
  const hangs = quiet(new Hangs('hangs'))
  const mirrors = new Wedgeable('mirrors')
  const { supervisor } = await harness(t, [hangs, mirrors])
  mirrors.wedge()

  await supervisor.probe()
  await supervisor.probe()
  t.is(supervisor.probing, false, 'the probe returned rather than parking on the recovery')
  t.alike(mirrors.recovered, ['u1'], 'the second subsystem was still reached')
})

test('a supervisor that has stopped completing probes reports itself unhealthy', async (t) => {
  const before = getRuntimeConfig()
  t.teardown(() => setRuntimeConfig(before))
  const intervalMs = 3_600_000
  setRuntimeConfig({ ...before, supervisionProbeIntervalMs: intervalMs })

  const { supervisor } = await harness(t, [])
  t.ok(supervisor.health().ok, 'a supervisor that has not probed yet is not a stopped one')
  await supervisor.probe()
  t.ok(supervisor.health().ok)

  supervisor.lastProbeAt = Date.now() - (intervalMs * 3) - 1000
  t.absent(supervisor.health().ok, 'three intervals of silence is a stopped supervisor')
  t.ok(supervisor.health().detail.includes('no probe'), 'and it says so')
})

test('a unit row with no key is dropped instead of colliding with another', async (t) => {
  class Sloppy extends Subsystem {
    supervise () { return [{ ok: false, detail: 'a' }, { ok: false, detail: 'b' }, { key: 'real', ok: false, detail: 'c' }] }
  }
  const { supervisor } = await harness(t, [quiet(new Sloppy('sloppy'))])
  t.alike(supervisor.collectRows().map((r) => r.key), ['real'], 'keyless rows never reach the policy')
})

test('an observe-only unit is stated in the log with its label and never recovered', async (t) => {
  class Watched extends Subsystem {
    constructor (name) { super(name); this.recovered = [] }
    supervise () { return [{ key: 'space:share', ok: false, detail: 'no progress for 700s', label: 'space:share', recoverable: false }] }
    async recover (key) { this.recovered.push(key) }
  }
  const watched = quiet(new Watched('owned-folders'))
  const { supervisor } = await harness(t, [watched])
  const warnings = []
  supervisor.log = { ...silentLog, warn: (...args) => warnings.push(args.join(' ')) }

  for (let i = 0; i < 4; i++) await supervisor.probe()
  t.alike(watched.recovered, [], 'a unit with no safe recovery is never acted on')
  t.ok(warnings.some((w) => w.includes('stalled, no recovery available') && w.includes('space:share')),
    'but the worker log names it — the redacted health report cannot')
  t.alike(supervisor.stats().recoveries, {}, 'and no budget was spent on it')
})

// REGRESSION (FIX-PROBE-CONTINUE: the per-subsystem `stopping` check used `return`, abandoning
// every remaining recovery in the probe. The policy has ALREADY charged each of those units a
// strike and a slice of its recovery budget by the time the loop runs, so one subsystem beginning
// to close billed every unit behind it for an attempt that never happened.)
test('REGRESSION (FIX-PROBE-CONTINUE): one subsystem closing does not skip the recoveries behind it', async (t) => {
  const first = new Wedgeable('first')
  const second = new Wedgeable('second')
  const { supervisor } = await harness(t, [first, second])
  first.wedge()
  second.wedge()
  // Begins closing between collectRows() and its own recover(), which is the real race.
  first.recover = async () => { first._stopping = true }

  await supervisor.probe()
  await supervisor.probe()
  t.alike(second.recovered, ['u1'], 'the subsystem behind it was still reached')
  t.is(supervisor.stats().recoveries.second, 1, 'and was billed for an attempt that happened')
})

test('a supervisor-wide pause still stops the whole probe', async (t) => {
  const first = new Wedgeable('first')
  const second = new Wedgeable('second')
  const { supervisor } = await harness(t, [first, second])
  first.wedge()
  second.wedge()
  first.recover = async (key) => { first.recovered.push(key); supervisor.pause() }

  await supervisor.probe()
  await supervisor.probe()
  t.alike(first.recovered, ['u1'])
  t.alike(second.recovered, [], 'a shutdown is not a per-subsystem skip')
})
