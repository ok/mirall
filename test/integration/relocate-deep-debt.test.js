import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { trackTimers } from '../helpers/timers.js'

// The shim must wrap the globals BEFORE the modules load, so everything under test comes in through
// a dynamic import (static ones are hoisted above it).
const timers = trackTimers()
const { offlineMemberRegistry } = await import('../helpers/store.js')
const { createSpace } = await import('../../src/shared/spaces/space.js')
const { publishShare, generateShareId } = await import('../../src/shared/shares/shares.js')
const { getLocalPublicKeyHex, setProfile } = await import('../../src/shared/spaces/profile.js')
const { createOwnedMount, getOwnedMount, patchOwnedMount } = await import('../../src/shared/folders/mount-store.js')
const { ownCatalogKeyHex } = await import('../../src/shared/shares/share-catalog.js')
const { boot } = await import('../../src/worker/boot.js')
const { createFakeIpc } = await import('../helpers/fake-ipc.js')

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }

// The debt is cleared by the pass, not by the call that armed it, so the assertion has to wait for
// the pass rather than read straight after the boot returns.
async function untilDebtClears (spaceId, shareId, deadlineMs = 5000) {
  const until = Date.now() + deadlineMs
  while (Date.now() < until) {
    if (!(await getOwnedMount(spaceId, shareId)).deepScanOwed) return true
    await new Promise((r) => setTimeout(r, 25))
  }
  return false
}
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mirall-deep-debt-${label}-`))

// A store that survives close/reopen, the way the two real boots below need it to.
function peerDirs (t) {
  const root = tmp('store')
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmp('dl')
  const mountPath = tmp('mount')
  fs.writeFileSync(path.join(mountPath, 'a.txt'), 'x')
  t.teardown(() => {
    for (const dir of [root, downloads, mountPath]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  })
  return {
    mountPath,
    masterSecret: crypto.randomBytes(32),
    config: { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads, overlayEnabled: true },
  }
}

async function seedMount (mountPath) {
  await setProfile({ displayName: 'Tester' })
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name: 'Vault',
    owner: getLocalPublicKeyHex(),
    contentMode: 'overlay',
    catalogKeyEnc: await ownCatalogKeyHex(space.spaceId),
    createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  await createOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  return { spaceId: space.spaceId, shareId: share.id }
}

// REGRESSION (FIX-R05-10: a relocate diffs by content hash because the tree it points at is a moved
// copy whose mtimes are all fresh. On the ACTIVE path that pass ran in a floating promise and
// NOTHING was written down, so a quit mid-walk left the next boot running its ordinary FAST
// reconcile — which misses on every new mtime and re-advertises the whole tree, and every mirroring
// peer re-downloads a folder that did not change.)
test('REGRESSION (FIX-R05-10): the next boot honours a deep-scan debt an interrupted relocate left', async (t) => {
  t.teardown(() => timers.restore())
  const { config, masterSecret, mountPath } = peerDirs(t)

  const first = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  const { spaceId, shareId } = await seedMount(mountPath)
  // The durable half of a relocate whose deep pass never finished.
  await patchOwnedMount(spaceId, shareId, { deepScanOwed: true })
  await first.close()

  const second = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  t.teardown(() => second.close())

  t.ok(await untilDebtClears(spaceId, shareId),
    'the boot resume ran the deep pass and cleared the debt on completion, rather than leaving the flag standing forever')
})

// The other half of the same rule, and the one an eager read-and-clear gets wrong: a pass that did
// not finish must leave the debt for whoever runs next. Otherwise a quit during the catch-up scan
// costs the whole-tree re-advertise the debt exists to prevent, one boot later instead of this one.
test('a pass that does not complete leaves the debt standing', async (t) => {
  t.teardown(() => timers.restore())
  const { config, masterSecret, mountPath } = peerDirs(t)

  const root = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  t.teardown(() => root.close())
  const { spaceId, shareId } = await seedMount(mountPath)
  await patchOwnedMount(spaceId, shareId, { deepScanOwed: true })
  const mount = await getOwnedMount(spaceId, shareId)

  for (const outcome of [{ cancelled: true }, { skipped: 'mount-point-gone' }, null]) {
    await patchOwnedMount(spaceId, shareId, { deepScanOwed: true })
    root.mounts.settleScanStatus = async () => outcome
    await root.mounts.armCatchUpScan(spaceId, shareId, mount)
    t.ok((await getOwnedMount(spaceId, shareId)).deepScanOwed,
      `a ${JSON.stringify(outcome)} pass still owes the deep scan`)
  }
})

// The hand-off the paused branch depends on: boot arms no pass for a paused index, so the debt must
// still be there when the user presses Resume.
test('a paused index keeps the debt for its resume, and the resume spends it exactly once', async (t) => {
  t.teardown(() => timers.restore())
  const { config, masterSecret, mountPath } = peerDirs(t)

  const first = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  const { spaceId, shareId } = await seedMount(mountPath)
  await first.mounts.pauseIndex(spaceId, shareId)
  await patchOwnedMount(spaceId, shareId, { deepScanOwed: true })
  await first.close()

  const second = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  t.teardown(() => second.close())
  t.ok((await getOwnedMount(spaceId, shareId)).deepScanOwed, 'boot left it standing for the resume')

  t.is((await second.mounts.resumeIndex(spaceId, shareId)).deep, true, 'the resume runs deep')
  t.ok(await untilDebtClears(spaceId, shareId), 'and its completed pass clears the debt')

  await second.mounts.pauseIndex(spaceId, shareId)
  t.is((await second.mounts.resumeIndex(spaceId, shareId)).deep, false,
    'a second resume runs fast — the debt is spent once, not re-run forever')
})

// The write side of the same rule, pinned by source because the pass it guards runs in a floating
// promise and cannot be observed from the outside without racing it.
test('relocate records the debt on both paths, before either pass is armed', (t) => {
  const srcRoot = path.join(path.dirname(import.meta.url.replace(/^file:\/\//, '')), '..', '..', 'src')
  const src = fs.readFileSync(path.join(srcRoot, 'worker', 'main.js'), 'utf8')
  const from = src.indexOf("ipc.handle('owned-folder:relocate'")
  const handler = src.slice(from, src.indexOf('ipc.handle(', from + 1))
  t.ok(from > 0 && handler.length > 0, 'found the relocate handler')

  const debtAt = handler.indexOf('deepScanOwed: true')
  const scanAt = handler.indexOf('initialPublishScan(')
  t.ok(debtAt > 0, 'it records the debt')
  t.ok(scanAt > debtAt, 'before it arms the pass — the flag is the durable fact, the running pass is not')
  t.absent(/if \(mount\.indexPaused\)[^\n]*deepScanOwed: true/.test(handler),
    'and unconditionally: the ACTIVE path owes it too, to whatever runs after a quit mid-walk')
})
