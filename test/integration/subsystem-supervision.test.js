import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { createLifecycle } from '../../src/shared/core/subsystem.js'
import { Supervisor } from '../../src/shared/core/supervisor.js'
import { DEFAULT_POLICY } from '../../src/shared/core/supervision.js'
import { setRuntimeConfig, getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  ForeignMirrors, runMaterializeTick, mirrorHealth, unmountForeignFolder,
} from '../../src/shared/folders/foreign-folders.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { wedgedMirror, waitUntil, delay } from '../helpers/wedged-mirror.js'

// The mirror loop's own wedge and restart are covered in foreign-mirror-restart.test.js. This file
// covers the mechanism that decides WHEN to restart it: the probe cadence, the consecutive-bad
// rule, the recovery budget and the teardown guards, all of which used to be hand-built inside
// MountsRuntime and are now shared by every subsystem that declares supervisable units.

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }

async function supervised (t, opts) {
  const wedge = await wedgedMirror(t, opts)
  // A probe interval long enough that only the explicit probe() calls below drive the policy.
  setRuntimeConfig({ ...getRuntimeConfig(), supervisionProbeIntervalMs: 3_600_000 })
  const life = createLifecycle({ log: silentLog })
  const mirrors = await life.start(new ForeignMirrors('foreign-mirrors', { ipc: createFakeIpc().ipc }))
  const supervisor = await life.start(new Supervisor('supervision', { lifecycle: life }))
  supervisor.log = silentLog
  mirrors.log = silentLog
  // Closing ForeignMirrors stops every loop, which the wedged-mirror teardown also does; ordering
  // is handled by brittle running this before the helper's own teardown.
  t.teardown(() => life.close())
  return { ...wedge, life, mirrors, supervisor }
}

test('a wedged mirror is reported as a supervisable unit labelled with its share id', async (t) => {
  const { spaceId, shareId, spy, mirrors } = await supervised(t, { pollMs: 50 })

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)
  t.alike(mirrors.supervise().map((row) => row.ok), [true], 'a pass that just started is not wedged')

  await waitUntil(() => mirrorHealth()[0]?.ok === false)
  const rows = mirrors.supervise()
  t.is(rows.length, 1)
  t.is(rows[0].ok, false)
  t.is(rows[0].label, shareId, 'the log-safe label is the share id')
  t.ok(rows[0].key.includes(shareId), 'and the key identifies the mount')
})

// REGRESSION (FIX-R09-2 / SUP-1: the mirror probe was hand-built inside MountsRuntime, so no other
// subsystem could be supervised at all). The behaviour asserted here is what #138 shipped; what is
// new is that it now runs through the shared supervisor.
test('REGRESSION (SUP-1: the supervisor recovers a wedged mirror after two consecutive bad probes)', async (t) => {
  const { spaceId, shareId, spy, supervisor } = await supervised(t, { pollMs: 50 })

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)
  await waitUntil(() => mirrorHealth()[0]?.ok === false)

  await supervisor.probe()
  t.is(spy.fetches, 1, 'one bad probe is not enough to act')

  await supervisor.probe()
  await waitUntil(() => spy.fetches === 2)
  t.is(spy.fetches, 2, 'the second consecutive bad probe restarts the loop')
  t.is(supervisor.stats().recoveries['foreign-mirrors'], 1)
})

// The base clears the probe interval on close, but a probe already awaiting a recovery when a
// shutdown begins would re-arm a loop the teardown just stopped.
test('the supervisor recovers nothing once it is paused', async (t) => {
  const { spaceId, shareId, spy, supervisor } = await supervised(t, { pollMs: 50 })

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)
  await waitUntil(() => mirrorHealth()[0]?.ok === false)

  supervisor.pause()
  await supervisor.probe()
  await supervisor.probe()
  await delay(50)
  t.is(spy.fetches, 1, 'no loop is restarted during teardown')
})

test('a mirror that cannot be recovered spends its budget and is then left down', async (t) => {
  const { spaceId, shareId, spy, supervisor } = await supervised(t, { pollMs: 50 })

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)

  // Every restart re-wedges, because fetchFile hangs for every pass.
  for (let i = 0; i < DEFAULT_POLICY.maxRecoveries; i++) {
    await waitUntil(() => mirrorHealth()[0]?.ok === false)
    await supervisor.probe()
    await supervisor.probe()
    await waitUntil(() => spy.fetches === i + 2)
  }
  t.is(spy.fetches, DEFAULT_POLICY.maxRecoveries + 1, 'the budget bought three restarts')

  await waitUntil(() => mirrorHealth()[0]?.ok === false)
  await supervisor.probe()
  await supervisor.probe()
  await delay(80)
  t.is(spy.fetches, DEFAULT_POLICY.maxRecoveries + 1, 'and then it stops rather than restarting forever')
  t.is(supervisor.stats().gaveUp['foreign-mirrors'], 1)
})

test('an unmounted mount stops being supervised and leaves no spent budget behind', async (t) => {
  const { spaceId, shareId, spy, mirrors, supervisor } = await supervised(t, { pollMs: 50 })

  runMaterializeTick(spaceId, shareId)
  await waitUntil(() => spy.fetches === 1)
  await waitUntil(() => mirrorHealth()[0]?.ok === false)
  await supervisor.probe()
  await supervisor.probe()
  t.is(supervisor.stats().recoveries['foreign-mirrors'], 1)

  await unmountForeignFolder(spaceId, shareId)
  t.alike(mirrors.supervise(), [], 'a mount with no live loop is not a supervisable unit')
  await supervisor.probe()
  t.alike(supervisor.stats().recoveries, {}, 'and its counters are pruned with it')
})

// A correct probe proves nothing about it running: requestFailures and requestMetrics both shipped
// as no-ops because the producer was built and never wired. Constructing the real root needs a
// booted store, so the wiring is pinned by source text, the way the crash-backstop suite pins boot.js.
test('REGRESSION (SUP-1 wiring): the supervisor is started last, paused first, and mirrors declare units', (t) => {
  const root = path.join(path.dirname(import.meta.url.replace(/^file:\/\//, '')), '..', '..', 'src')
  const boot = fs.readFileSync(path.join(root, 'worker', 'boot.js'), 'utf8')
  const mirrors = fs.readFileSync(path.join(root, 'shared', 'folders', 'foreign-folders.js'), 'utf8')
  const mounts = fs.readFileSync(path.join(root, 'worker', 'mounts-runtime.js'), 'utf8')

  t.ok(boot.indexOf('new Supervisor(') > boot.indexOf('new Sweeps('),
    'the supervisor starts after every subsystem it supervises, so it closes first')
  const closeBody = boot.slice(boot.indexOf('async function close({'), boot.indexOf('onPartialRoot?.('))
  t.ok(closeBody.indexOf('supervisor?.pause()') < closeBody.indexOf('broadcastDeparture()'),
    'and it is paused before the shutdown flush window, not only by life.close()')
  t.ok(/supervision: \(\) => supervisor/.test(boot), 'its counters reach the root for diagnostics')

  t.ok(/^ {2}supervise\(/m.test(mirrors), 'ForeignMirrors declares its supervisable units')
  t.ok(/^ {2}async recover\(/m.test(mirrors), 'and the recovery the supervisor drives')

  t.absent(/probeMirrorLiveness/.test(mounts), 'the hand-built probe is gone, not duplicated')
  t.absent(/restartForeignLoop/.test(mounts), 'and the mount runtime no longer drives the restart')
})
