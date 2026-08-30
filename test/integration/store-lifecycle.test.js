import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer, offlineMemberRegistry } from '../helpers/store.js'
import { boot } from '../../src/worker/boot.js'
import { createFakeIpc } from '../helpers/fake-ipc.js'
import { getRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { getStore, openSessionNames } from '../../src/shared/core/store.js'
import { createSpace, getDrive, listJoinRequests, recordJoinRequest } from '../../src/shared/spaces/space.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { saveOwnedMount } from '../../src/shared/folders/mount-store.js'
import { onFsEvent } from '../../src/shared/folders/owned-folders.js'
import { ownCatalog, advertise, collectOwnShare } from '../../src/shared/shares/share-catalog.js'
import { openMemberView } from '../../src/shared/spaces/member-registry.js'

const quiet = { debug () {}, info () {}, warn () {}, error () {} }

async function ownedShareWithFile (ctx, name) {
  const space = await createSpace(name)
  const share = {
    id: generateShareId(), type: 'owned-folder', name: 'Vault', contentMode: 'overlay',
    owner: getLocalPublicKeyHex(), createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  await saveOwnedMount({ spaceId: space.spaceId, shareId: share.id, mountPath, ignore: [], createdAt: Date.now() })
  const abs = path.join(mountPath, 'one.txt')
  fs.writeFileSync(abs, 'one')
  await onFsEvent(space.spaceId, share.id, 'add', 'one.txt', abs)
  return { space, share, mountPath }
}

// REGRESSION (LIFECYCLE-2a: root.close() reached store.close() with every bee, catalog and drive
// still open — Corestore closed them as a side effect, and the wrappers over them never learned
// it. Two spaces with a published file each and a member view measured nine such sessions.)
test('REGRESSION (LIFECYCLE-2a): the store closes with zero sessions still open', async (t) => {
  const ctx = await freshPeer(t)
  for (const name of ['Aurora', 'Borealis']) {
    const { space } = await ownedShareWithFile(ctx, name)
    await openMemberView(space.spaceId).catch(() => {})
  }
  // Guards against the assertion below passing vacuously: the fixture must genuinely hold the
  // bees, catalogs and drives whose ownership this test is about.
  t.ok(openSessionNames().length >= 6, 'the fixture holds real sessions while running (' + openSessionNames().length + ')')

  await ctx.root.close()

  t.alike(ctx.root.store.leakedSessions, [], 'nothing was left for the store to close: ' +
    ctx.root.store.leakedSessions.map((s) => s.name).join(', '))
  t.absent(getStore(), 'getStore() is undefined after close')
})

// REGRESSION (LIFECYCLE-2b: share-catalog.js cached the own-catalog bee across a restart. The
// store had closed its session, the wrapper still reported closed === false, and the first write
// to any space that existed before the restart threw SESSION_CLOSED.)
test('REGRESSION (LIFECYCLE-2b): a catalog write on a pre-restart space works after the restart', async (t) => {
  const ctx = await freshPeer(t)
  const { space, share } = await ownedShareWithFile(ctx, 'Aurora')
  const before = await ownCatalog(space.spaceId)
  recordJoinRequest(space.spaceId, 'a'.repeat(64), 'Joiner')
  const config = getRuntimeConfig()
  await ctx.root.close()

  const second = await boot(config, { ipc: createFakeIpc().ipc, log: quiet, swarm: false, masterSecret: null, memberRegistry: offlineMemberRegistry })
  t.teardown(() => second.close())

  const after = await ownCatalog(space.spaceId)
  t.not(after, before, 'the catalog is a fresh bee, not the one the closed store left behind')
  await advertise(space.spaceId, share.id, 'two.txt', { size: 3, mtime: 1 })
  const { entries } = await collectOwnShare(space.spaceId, share.id)
  t.ok(entries.some((e) => e.relPath === 'two.txt'), 'and the write landed')
  t.absent(getDrive(space.spaceId)?.core.closed, 'the drive is live')
  t.is(listJoinRequests(space.spaceId).length, 0, 'a join request is this-session state and did not survive')
})

// The handles are owned, so a close that never reaches the store still closes them — and a bee
// closed after its store is a no-op, not a throw.
test('the durable tier tolerates the store closing out from under it', async (t) => {
  const ctx = await freshPeer(t)
  await getStore().close()
  await ctx.root.close()
  t.pass('closing the tier after the store is harmless')
})
