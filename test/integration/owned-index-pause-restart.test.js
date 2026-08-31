import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import crypto from 'hypercore-crypto'
import { trackTimers } from '../helpers/timers.js'

// The shim must wrap the globals BEFORE the modules load, so everything under test comes in through
// a dynamic import (static ones are hoisted above it) — same reason as lifecycle-restart.test.js.
const timers = trackTimers()
const { offlineMemberRegistry } = await import('../helpers/store.js')
const { createSpace } = await import('../../src/shared/spaces/space.js')
const { publishShare, generateShareId } = await import('../../src/shared/shares/shares.js')
const { getLocalPublicKeyHex } = await import('../../src/shared/spaces/profile.js')
const { setProfile } = await import('../../src/shared/spaces/profile.js')
const { saveOwnedMount, getOwnedMount } = await import('../../src/shared/folders/mount-store.js')
const { ownCatalogKeyHex } = await import('../../src/shared/shares/share-catalog.js')
const { boot } = await import('../../src/worker/boot.js')
const { createFakeIpc } = await import('../helpers/fake-ipc.js')

const silentLog = { debug () {}, info () {}, warn () {}, error () {} }
const tmp = (label) => fs.mkdtempSync(path.join(os.tmpdir(), `mirall-index-pause-${label}-`))

// The headline requirement, and a second real boot is the only honest way to assert it: an
// in-process flag check would pass even if nothing had been persisted, and freshDurable would not
// run MountsRuntime at all — so it could observe neither half.
test('the pause survives a restart, and boot arms no cadence for it', async (t) => {
  t.teardown(() => timers.restore())
  // Nested like production (<peerDir>/app-storage): identity.enc and space-keys.enc are written
  // to dirname(storage), and a flat tmp dir would share them with every other test.
  const root = tmp('store')
  const storage = path.join(root, 'app-storage')
  fs.mkdirSync(storage, { recursive: true })
  const downloads = tmp('dl')
  t.teardown(() => {
    for (const dir of [root, downloads]) { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} }
  })
  const config = { storage, appVersion: '0.0.0-test', dev: true, verbose: false, downloadFolder: downloads, overlayEnabled: true }
  // Passed to BOTH boots: a space needs the master secret, and the cores are keyPair-derived from
  // it, so the restart only reopens the same store when it presents the same one.
  const masterSecret = crypto.randomBytes(32)

  const first = await boot(config, { ipc: createFakeIpc().ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
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
  const mountPath = tmp('mount')
  t.teardown(() => { try { fs.rmSync(mountPath, { recursive: true, force: true }) } catch {} })
  fs.writeFileSync(path.join(mountPath, 'a.txt'), 'x')
  await saveOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })

  await first.mounts.pauseIndex(space.spaceId, share.id)
  await first.close()

  const fake = createFakeIpc()
  const second = await boot(config, { ipc: fake.ipc, log: silentLog, swarm: false, masterSecret, memberRegistry: offlineMemberRegistry })
  t.teardown(() => second.close())

  t.ok((await getOwnedMount(space.spaceId, share.id)).indexPaused, 'the flag is durable')
  t.absent(second.mounts.periodicTimers.has(space.spaceId + ':' + share.id),
    'and boot armed no reconcile for it — an interval that can never do work reads as a bug')
  t.ok(fake.events.some((e) => e.type === 'event:owned-folder-mount-status'
    && e.payload.shareId === share.id && e.payload.status === 'paused'),
  'the paused badge repaints from the durable record, not from an event nobody sent')
  // A paused INDEX is not a paused FOLDER: the watcher still starts, so edits are not lost.
  t.ok(fake.events.some((e) => e.type === 'main-request'
    && e.payload.command === 'owned-folder:start-watcher' && e.payload.args.shareId === share.id),
  'and the watcher is still started')
})
