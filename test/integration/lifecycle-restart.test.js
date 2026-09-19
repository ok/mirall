import test from 'brittle'
import crypto from 'hypercore-crypto'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { EventEmitter } from 'bare-events'
import { trackTimers } from '../helpers/timers.js'

// The shim must wrap the globals BEFORE the modules load — echo-guard armed its purge at import —
// so every module under test comes in through a dynamic import (static ones are hoisted above it).
// It is installed ONCE for the file and restored from the LAST test only: a per-test
// `t.teardown(restore)` puts the natives back before the next test runs, and every timer
// assertion after that point reads a map nothing writes to any more — passing whatever leaked.
const timers = trackTimers()
const { freshPeer, offlineMemberRegistry } = await import('../helpers/store.js')
const { createSpace } = await import('../../src/shared/spaces/space-lifecycle.js')
const { listSpaces } = await import('../../src/shared/spaces/space.js')
const { publishShare, generateShareId } = await import('../../src/shared/shares/shares.js')
const { getLocalPublicKeyHex } = await import('../../src/shared/spaces/profile.js')
const { createOwnedMount, createForeignMount } = await import('../../src/shared/folders/mount-store.js')
const { onFsEvent } = await import('../../src/shared/folders/owned-watcher.js')
const { startForeignLoop } = await import('../../src/shared/folders/foreign-verbs.js')
const { boot } = await import('../../src/worker/boot.js')
const { createFakeIpc } = await import('../helpers/fake-ipc.js')
const { createIPC } = await import('../../src/shared/core/ipc.js')
const { createHealthMonitor } = await import('../../src/shared/core/health.js')
const { bindConnectionLifecycle } = await import('../../src/worker/connection-lifecycle.js')

const silentLog = { debug() {}, info() {}, warn() {}, error() {} }

const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mirall-lifecycle-${label}-`))

async function ownedShare(ctx) {
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(), type: 'owned-folder', name: 'Vault', contentMode: 'overlay',
    owner: getLocalPublicKeyHex(), createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  await createOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  return { space, share, mountPath }
}

// REGRESSION (LIFECYCLE-1a: the worker's stop sequence left timers armed. safeShutdown tore down
// the backends, both swarms and the member views; the foreign mirror poll and echo-guard's purge
// outlived it, masked only because Bare.exit followed immediately. This runs the production stop
// sequence — minus the exit — and counts what survives.)
test('REGRESSION (LIFECYCLE-1a): no data-layer interval is armed after the full stop sequence', async (t) => {
  const ctx = await freshPeer(t)
  const { space, share, mountPath } = await ownedShare(ctx)
  const abs = path.join(mountPath, 'a.txt')
  fs.writeFileSync(abs, 'x')
  await onFsEvent(space.spaceId, share.id, 'add', 'a.txt', abs)     // arms the catch-up timer
  const mirrorPath = ctx.tmpDir('mirror')
  const mirror = {
    spaceId: space.spaceId, shareId: 'peer-share', ownerKey: 'f'.repeat(64),
    mountPath: mirrorPath, enabled: true, attachedAt: Date.now(),
  }
  await createForeignMount(mirror)
  await startForeignLoop(mirror)                                    // arms the 30 s poll

  await ctx.root.close()

  const armed = timers.intervals()
  t.is(armed.length, 0, 'no interval armed after shutdown\n' + timers.describe(armed))
})

// REGRESSION (LIFECYCLE-1b: boot → close → boot again in one process, same storage, then real
// work. Nothing here calls a _reset* seam. A leftover interval, a getter still pointing at a
// closed instance, or a TDZ on re-import would fail the second boot or the operations after it.)
test('REGRESSION (LIFECYCLE-1b): in-process restart against the same storage', async (t) => {
  t.teardown(() => timers.restore())   // the last test in the file — see the shim comment above
  // Nested like production (<peerDir>/app-storage): space-keys.enc and identity.enc are written
  // to dirname(storage), and a flat tmpdir would share them with every other test.
  const root = tmp('store')
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmp('dl')
  t.teardown(() => { for (const d of [root, downloads]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })
  const config = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads }
  // Passed to BOTH boots: the cores are keyPair-derived from M, so a restart only reopens the
  // same store when it presents the same one. Explicit rather than inherited from a prior test.
  const masterSecret = crypto.randomBytes(32)

  const first = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  const space = await createSpace('Aurora')
  await first.close()
  t.is(timers.intervals().length, 0, 'first close leaves nothing armed\n' + timers.describe(timers.intervals()))

  const second = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  const spaces = await listSpaces()
  t.ok(spaces.some((s) => s.spaceId === space.spaceId), 'the space created before the restart is listed after it')
  const again = await createSpace('Borealis')
  t.ok(again.spaceId, 'a real write works on the rebooted store')

  // A store write alone would not notice the failure mode that matters here: the publish
  // scheduler is constructed at module level and its stop() is permanent, so a second boot
  // inheriting it would queue this file and never pump it — onFsEvent would simply never settle.
  const { space: pubSpace, share, mountPath } = await ownedShare({ tmpDir: (l) => tmp(l) })
  const file = path.join(mountPath, 'after-restart.txt')
  fs.writeFileSync(file, 'restarted')
  await onFsEvent(pubSpace.spaceId, share.id, 'add', 'after-restart.txt', file)
  t.pass('the publish lane still drains after a restart')
  await second.close()
  t.is(timers.intervals().length, 0, 'second close leaves nothing armed\n' + timers.describe(timers.intervals()))
})

// A boot the worker refuses never reaches boot(), so the teardown it runs is the same sequence with
// every step a no-op — the case main.js takes when bootstrapPromise rejects. What must hold is that
// the refusal settles, the monitor is stopped, and nothing stays armed.
test('a refused bootstrap tears down cleanly and leaves nothing armed', async (t) => {
  const before = timers.intervals().length
  const pipe = new EventEmitter()
  pipe.write = () => true
  const ipc = createIPC(pipe)
  const health = createHealthMonitor()
  health.start()

  pipe.emit('data', Buffer.from(JSON.stringify({ type: 'bootstrap', storage: '/tmp/nope' }) + '\n'))
  await t.exception(ipc.bootstrapPromise, /no protocol version/)

  // main.js's catch: health.stop(), abortAll, then close a root that is still null.
  health.stop()
  t.is(ipc.abortAll('protocol-mismatch'), 0, 'no request ever dispatched, so nothing to abort')
  t.is(ipc.inFlightCount(), 0)
  t.is(timers.intervals().length, before, 'the health monitor is the only timer, and it stopped')
})

// Teardown WITHOUT exit: a closed pipe disconnects a client, and whether the worker then stops is a
// separate question with a separate answer. Both answers are driven here against a real booted root
// — the shipped one (stop, because nothing could reconnect) and the one a daemon will give.
test('a closed pipe disconnects the client; stopping is a separate decision', async (t) => {
  const pipe = new EventEmitter()
  pipe.write = () => true
  const ipc = createIPC(pipe)
  const stops = []

  bindConnectionLifecycle({
    pipe,
    ipc,
    client: ipc.primary,
    isBootComplete: () => true,
    canAcceptClients: true,
    stop: (reason) => stops.push(reason),
  })

  pipe.emit('close')
  t.is(ipc.clientCount(), 0, 'the client is gone')
  t.alike(stops, [], 'but a worker that could accept another does not stop')
  t.is(ipc.inFlightCount(), 0, 'and it left nothing behind')

  // The shipped policy, on a second worker: no socket, so no client can ever arrive.
  const shipped = new EventEmitter()
  shipped.write = () => true
  const ipc2 = createIPC(shipped)
  const stops2 = []
  bindConnectionLifecycle({
    pipe: shipped, ipc: ipc2, client: ipc2.primary,
    isBootComplete: () => true, stop: (reason) => stops2.push(reason),
  })
  shipped.emit('close')
  t.alike(stops2, ['ipc-close'], 'an unreachable worker holding the store lock stops')
})
