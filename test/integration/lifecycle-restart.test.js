import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { trackTimers } from '../helpers/timers.js'

// The shim must wrap the globals BEFORE the modules load — echo-guard armed its purge at import —
// so every module under test comes in through a dynamic import (static ones are hoisted above it).
// It is installed ONCE for the file and restored from the LAST test only: a per-test
// `t.teardown(restore)` puts the natives back before the next test runs, and every timer
// assertion after that point reads a map nothing writes to any more — passing whatever leaked.
const timers = trackTimers()
const { freshPeer } = await import('../helpers/store.js')
const { createSpace, listSpaces } = await import('../../src/shared/spaces/space.js')
const { publishShare, generateShareId } = await import('../../src/shared/shares/shares.js')
const { getLocalPublicKeyHex } = await import('../../src/shared/spaces/profile.js')
const { saveOwnedMount, saveForeignMount } = await import('../../src/shared/folders/mount-store.js')
const { onFsEvent } = await import('../../src/shared/folders/owned-folders.js')
const { startForeignLoop } = await import('../../src/shared/folders/foreign-folders.js')
const { getStore } = await import('../../src/shared/core/store.js')
const { closeAllMemberViews } = await import('../../src/shared/spaces/member-registry.js')
const { teardownBackends } = await import('../../src/shared/transfer/content-backends.js')
const { destroyContentSwarm } = await import('../../src/shared/transfer/content-swarm.js')
const { destroySwarm } = await import('../../src/shared/transfer/swarm.js')
const { boot } = await import('../../src/worker/boot.js')
const { createFakeIpc } = await import('../helpers/fake-ipc.js')

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }

// Every periodic timer the data layer arms is unref'd, and the boot root deliberately holds no
// ref'd handle — in production the worker's IPC pipe is what keeps the loop alive. Under the test
// runner there is no pipe, so a ref'd tick stands in for it.
function keepLoopAlive (t) {
  const beat = setInterval(() => {}, 1000)
  t.teardown(() => clearInterval(beat))
}
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mirall-lifecycle-${label}-`))

async function ownedShare (ctx) {
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(), type: 'owned-folder', name: 'Vault', contentMode: 'overlay',
    owner: getLocalPublicKeyHex(), createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  await saveOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
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
  await saveForeignMount(mirror)
  await startForeignLoop(mirror)                                    // arms the 30 s poll

  const { stopAllForeignLoops } = await import('../../src/shared/folders/foreign-folders.js')
  const { _resetOwnedFolders } = await import('../../src/shared/folders/owned-folders.js')
  const { closeAuditLog } = await import('../../src/shared/audit/audit-log.js')
  const { closePeerWatch } = await import('../../src/shared/audit/peer-watch.js')
  await stopAllForeignLoops()
  await _resetOwnedFolders()
  await closePeerWatch()
  await closeAuditLog()
  closeAllMemberViews()
  await teardownBackends()
  await destroyContentSwarm()
  await destroySwarm()
  await getStore().close()

  const armed = timers.intervals()
  t.is(armed.length, 0, 'no interval armed after shutdown\n' + timers.describe(armed))
})

// REGRESSION (LIFECYCLE-1b: boot → close → boot again in one process, same storage, then real
// work. Nothing here calls a _reset* seam. A leftover interval, a getter still pointing at a
// closed instance, or a TDZ on re-import would fail the second boot or the operations after it.)
test('REGRESSION (LIFECYCLE-1b): in-process restart against the same storage', async (t) => {
  keepLoopAlive(t)
  t.teardown(() => timers.restore())   // the last test in the file — see the shim comment above
  const storage = tmp('store')
  const downloads = tmp('dl')
  t.teardown(() => { for (const d of [storage, downloads]) { try { fs.rmSync(d, { recursive: true, force: true }) } catch {} } })
  const config = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads }

  const first = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false })
  const space = await createSpace('Aurora')
  await first.close()
  t.is(timers.intervals().length, 0, 'first close leaves nothing armed\n' + timers.describe(timers.intervals()))

  const second = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false })
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
