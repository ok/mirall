import test from 'brittle'
import { loadWithFakeChokidar } from '../helpers/fake-chokidar.js'

const { created, modules } = loadWithFakeChokidar(['src/main/watch-host.js'])
const { createWatchHost, looksLikeNetworkPath } = modules[0]

function host (opts = {}) {
  created.length = 0
  const events = []
  const errors = []
  const storms = []
  const h = createWatchHost({
    label: 't',
    onEvent: (e) => events.push(e),
    onError: (e) => errors.push(e),
    onStorm: () => storms.push(true),
    ...opts,
  })
  return { h, events, errors, storms }
}

const polling = () => created.filter((w) => w.opts.usePolling)
const native = () => created.filter((w) => !w.opts.usePolling)

// REGRESSION (FIX-PI3-1: a loose file on a network volume got no watcher events at all. Native
// filesystem events do not cross a network mount, so the app kept serving a stale version —
// silently, with no error and no badge. The owned-folder watcher polled such mounts from the
// day it was written; the loose watcher never learned it. The host makes that impossible: a
// target is routed by the same predicate no matter which caller armed it.)
test('REGRESSION (FIX-PI3-1): a network path is watched by polling, not native events', (t) => {
  const { h } = host()
  h.add('/Volumes/NAS/a.txt')
  t.is(polling().length, 1, 'a polling instance was created')
  t.is(polling()[0].opts.interval, 5000, 'and it polls every 5s')
  t.is(native().length, 0, 'no native instance for a network-only target')
  t.teardown(() => h.stop())
})

test('a local path never creates a polling instance', (t) => {
  const { h } = host()
  h.add('/Users/me/Documents/a.txt')
  t.is(polling().length, 0, 'no polling instance')
  t.is(native().length, 1, 'one native instance')
  t.is(native()[0].opts.usePolling, false)
  t.absent(native()[0].opts.interval, 'no poll interval on the native instance')
  t.teardown(() => h.stop())
})

test('one host serves both kinds of target from the same event callback', (t) => {
  const { h, events } = host()
  h.add('/Users/me/a.txt')
  h.add('/Volumes/NAS/b.txt')
  t.is(created.length, 2, 'two chokidar instances, one host')
  native()[0].emit('change', '/Users/me/a.txt')
  polling()[0].emit('change', '/Volumes/NAS/b.txt')
  t.alike(events.map((e) => e.absPath), ['/Users/me/a.txt', '/Volumes/NAS/b.txt'], 'both route to the same onEvent')
  t.alike(events.map((e) => e.action), ['change', 'change'])
  t.teardown(() => h.stop())
})

test('the polling instance is created lazily — no network target, no polling cost', (t) => {
  const { h } = host()
  h.add('/Users/me/a.txt')
  h.add('/Users/me/b.txt')
  t.is(created.length, 1, 'one instance for two local targets')
  t.teardown(() => h.stop())
})

test('add/change/unlink all reach onEvent', (t) => {
  const { h, events } = host()
  h.add('/Users/me/a.txt')
  for (const action of ['add', 'change', 'unlink']) created[0].emit(action, '/Users/me/a.txt')
  t.alike(events.map((e) => e.action), ['add', 'change', 'unlink'])
  t.teardown(() => h.stop())
})

// REGRESSION (FIX-PI3-2: the loose watcher forwarded errors and did nothing else, so an erroring
// watcher spun for the life of the process. The owned side stopped itself after five errors in
// ten seconds; the cut-off now covers both.)
test('REGRESSION (FIX-PI3-2): >5 errors in 10s stops the host and reports why', (t) => {
  const { h, errors, storms } = host()
  h.add('/Users/me/a.txt')
  const w = created[0]
  for (let i = 0; i < 6; i++) w.emit('error', new Error('boom' + i))
  t.is(storms.length, 1, 'onStorm fired once')
  t.is(errors.length, 7, 'six forwarded errors plus the storm report')
  t.ok(/error-storm: watcher stopped for t/.test(errors[6].message), 'the report names the host')
  t.ok(w.closed, 'the instance was closed')
})

test('errors spread beyond the window do not trip the storm cut-off', (t) => {
  const realNow = Date.now
  let now = 1_000_000
  Date.now = () => now
  t.teardown(() => { Date.now = realNow })

  const { h, storms } = host()
  h.add('/Users/me/a.txt')
  const w = created[0]
  for (let i = 0; i < 10; i++) { w.emit('error', new Error('slow' + i)); now += 4000 }
  t.is(storms.length, 0, 'ten errors 4s apart is not a storm')
  t.teardown(() => h.stop())
})

test('a stormed host stays stopped — add() must not re-arm it', (t) => {
  const { h } = host()
  h.add('/Users/me/a.txt')
  for (let i = 0; i < 6; i++) created[0].emit('error', new Error('boom'))
  const countAfterStorm = created.length
  h.add('/Users/me/b.txt')
  t.is(created.length, countAfterStorm, 'no new instance after a storm')
})

test('an event arriving after stop() is dropped', (t) => {
  const { h, events } = host()
  h.add('/Users/me/a.txt')
  const w = created[0]
  h.stop()
  w.emit('change', '/Users/me/a.txt')
  t.is(events.length, 0, 'no event after stop')
})

test('stop() closes every instance, and a close throw does not escape', (t) => {
  const { h } = host()
  h.add('/Users/me/a.txt')
  h.add('/Volumes/NAS/b.txt')
  created[0].closeError = new Error('close failed')
  t.execution(() => h.stop(), 'stop() swallows a close throw')
  t.ok(created[1].closed, 'the second instance was still closed')
})

test('remove() unwatches on the instance that holds the target', (t) => {
  const { h } = host()
  h.add('/Users/me/a.txt')
  h.add('/Volumes/NAS/b.txt')
  h.remove('/Volumes/NAS/b.txt')
  t.alike(native()[0].targets, ['/Users/me/a.txt'], 'the native instance is untouched')
  t.alike(polling()[0].targets, [], 'the polling instance dropped its target')
  t.teardown(() => h.stop())
})

test('remove() before any matching instance exists is a no-op', (t) => {
  const { h } = host()
  t.execution(() => h.remove('/Volumes/NAS/gone.txt'))
  t.is(created.length, 0, 'nothing was constructed just to unwatch')
})

// The descriptor is the ONLY place the two callers may differ. atomic and ignored come from it;
// everything else is fixed by the host, which is what stops the option bags drifting apart again.
test('the descriptor carries atomic and ignored; the rest of the option bag is fixed', (t) => {
  const ignoreFn = () => false
  const { h } = host({ atomic: true, ignored: ignoreFn })
  h.add('/Users/me/a.txt')
  const opts = created[0].opts
  t.is(opts.atomic, true, 'atomic comes from the descriptor')
  t.is(opts.ignored, ignoreFn, 'so does ignored')
  t.is(opts.ignoreInitial, true)
  t.is(opts.followSymlinks, false)
  t.is(opts.alwaysStat, true)
  t.alike(opts.awaitWriteFinish, { stabilityThreshold: 1000, pollInterval: 100 })
  t.teardown(() => h.stop())
})

test('atomic defaults to false, and ignored is omitted when the caller has none', (t) => {
  const { h } = host()
  h.add('/Users/me/a.txt')
  t.is(created[0].opts.atomic, false)
  t.absent('ignored' in created[0].opts, 'no ignored key when the caller passed none')
  t.teardown(() => h.stop())
})

test('looksLikeNetworkPath across the three platforms', (t) => {
  const real = process.platform
  const asPlatform = (p, fn) => {
    Object.defineProperty(process, 'platform', { value: p, configurable: true })
    try { fn() } finally { Object.defineProperty(process, 'platform', { value: real, configurable: true }) }
  }
  t.teardown(() => Object.defineProperty(process, 'platform', { value: real, configurable: true }))

  asPlatform('win32', () => {
    t.ok(looksLikeNetworkPath('\\\\server\\share\\a.txt'), 'UNC')
    t.absent(looksLikeNetworkPath('C:\\Users\\me\\a.txt'), 'a local drive letter')
  })
  asPlatform('darwin', () => {
    t.ok(looksLikeNetworkPath('/Volumes/NAS/a.txt'), '/Volumes')
    t.ok(looksLikeNetworkPath('\\\\server\\share\\a.txt'), 'UNC is platform-independent')
    t.absent(looksLikeNetworkPath('/Users/me/a.txt'), 'a home path')
    t.absent(looksLikeNetworkPath('/mnt/x/a.txt'), '/mnt is a linux-only signal')
  })
  asPlatform('linux', () => {
    t.ok(looksLikeNetworkPath('/mnt/nas/a.txt'), '/mnt')
    t.ok(looksLikeNetworkPath('/media/usb/a.txt'), '/media')
    t.absent(looksLikeNetworkPath('/Volumes/NAS/a.txt'), '/Volumes is a darwin-only signal')
    t.absent(looksLikeNetworkPath('/home/me/a.txt'), 'a home path')
  })
  t.absent(looksLikeNetworkPath(''), 'empty')
  t.absent(looksLikeNetworkPath(null), 'null')
})
