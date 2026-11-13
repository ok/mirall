import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { freshPeer } from '../helpers/store.js'
import { waitFor } from '../helpers/bare-poll.js'
import { fakeWatchEnv } from '../helpers/fake-watcher.js'
import { getLocalPublicKeyHex } from '../../src/shared/spaces/profile.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { publishShare, generateShareId } from '../../src/shared/shares/shares.js'
import { getOwnEntry, ownCatalogKeyHex } from '../../src/shared/shares/own-catalog.js'
import { looseShareFile } from '../../src/shared/transfer/overlay/loose-publish.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'
import { createOwnedMounter } from '../../src/worker/owned-mount.js'
import { FileWatchers } from '../../src/worker/watchers/file-watchers.js'

// The real watcher package under Bare, on bare-fs, delivering into the data layer in-process: a
// write, an edit and a delete on disk land in the owner's catalog with nothing else driving them.
// Generous deadlines: the watcher waits a second for a write to settle before it reports.

async function ownedShareMounted(t, { fileWatchers = true } = {}) {
  const ctx = await freshPeer(t, { fileWatchers })
  const space = await createSpace('Aurora')
  const share = {
    id: generateShareId(),
    type: 'owned-folder',
    name: 'Notes',
    owner: getLocalPublicKeyHex(),
    contentMode: 'overlay',
    catalogKey: await ownCatalogKeyHex(space.spaceId),
    createdAt: Date.now(),
  }
  await publishShare(space.spaceId, share)
  const mountPath = ctx.tmpDir('mount')
  fs.writeFileSync(path.join(mountPath, 'first.txt'), 'one')
  const mount = createOwnedMounter({ ipc: ctx.fake.ipc, mounts: ctx.root.mounts })
  await mount({ spaceId: space.spaceId, share, validated: { mountPath, advisories: [] } })
  // The mount's own scan publishes what is already there; a write during it would be the scan's.
  await waitFor(() => ctx.fake.emitted('event:owned-folder-scan-completed').length > 0, 15000, { label: 'the mount\'s own scan' })
  const entry = (relPath) => getOwnEntry(space.spaceId, share.id, relPath)
  return { ...ctx, spaceId: space.spaceId, share, mountPath, entry }
}

test('an owned folder: a file added, edited and deleted on disk reaches the catalog through the watcher', async (t) => {
  const { root, share, mountPath, entry } = await ownedShareMounted(t)
  t.is(root.fileWatchers.watchedOwnedPath(share.id), mountPath, 'the mount armed a real watcher on the folder')

  fs.mkdirSync(path.join(mountPath, 'sub'))
  fs.writeFileSync(path.join(mountPath, 'sub', 'added.txt'), 'added on disk')
  await waitFor(async () => (await entry('sub/added.txt'))?.contentHash, 15000, { label: 'the add published' })
  t.is((await entry('sub/added.txt')).size, 'added on disk'.length, 'a new file in a new folder is published')

  const before = (await entry('first.txt')).contentHash
  fs.writeFileSync(path.join(mountPath, 'first.txt'), 'one, edited')
  await waitFor(async () => {
    const e = await entry('first.txt')
    return e?.contentHash && e.contentHash !== before
  }, 15000, { label: 'the edit republished' })
  t.is((await entry('first.txt')).size, 'one, edited'.length, 'an edit is republished')

  fs.unlinkSync(path.join(mountPath, 'sub', 'added.txt'))
  await waitFor(async () => (await entry('sub/added.txt')) === null, 15000, { label: 'the delete retired' })
  t.pass('a delete retires the entry')
})

test('a loose file: an edit on disk is republished through the watcher', async (t) => {
  const ctx = await freshPeer(t, { fileWatchers: true })
  const space = await createSpace('Aurora')
  const abs = path.join(ctx.tmpDir('loose'), 'notes.md')
  fs.writeFileSync(abs, 'draft')
  await looseShareFile(space.spaceId, abs, 'notes.md')
  t.alike(ctx.root.fileWatchers.spacesWatchingLoose(abs), [space.spaceId], 'sharing the file armed its watch')

  const entry = () => getOwnEntry(space.spaceId, LOOSE_SHARE_ID, 'notes.md')
  const before = (await entry()).contentHash
  fs.writeFileSync(abs, 'draft, then edited')
  await waitFor(async () => {
    const e = await entry()
    return e?.contentHash && e.contentHash !== before
  }, 15000, { label: 'the loose edit republished' })
  t.is((await entry()).size, 'draft, then edited'.length)
})

test('the switched-off watchers keep their bookkeeping and report nothing', async (t) => {
  const { root, share, mountPath, entry } = await ownedShareMounted(t, { fileWatchers: false })
  t.is(root.fileWatchers.watchedOwnedPath(share.id), mountPath, 'the watch is recorded')
  fs.writeFileSync(path.join(mountPath, 'unseen.txt'), 'x')
  // absolute: long enough for a real watcher to have reported and published twice over.
  await new Promise((resolve) => setTimeout(resolve, 3000))
  t.is(await entry('unseen.txt'), null, 'no watcher delivered the write')
})

// A watcher fault never takes the back end down: an engine that refuses to arm, and an event whose
// handling fails, are each logged and dropped.
test('a watcher that cannot arm, and an event that cannot be handled, are logged and dropped', async (t) => {
  const fake = fakeWatchEnv()
  const throwing = { ...fake.env, engine: { watch() { throw new Error('no watch for you') } } }
  const refused = new FileWatchers('fw-refuses', { env: throwing })
  await refused.ready()
  refused.log = fake.env.log
  t.execution(() => refused.watchOwned('s1', '/data/x', []), 'a throwing arm does not escape')
  t.execution(() => refused.watchLoose('sp', '/data/y.txt'), 'nor does a loose one')
  t.ok(fake.warned.some((l) => l.includes('watch not armed for') && l.includes('no watch for you')), 'it is logged')
  await refused.close()

  const delivering = new FileWatchers('fw-delivers', { env: fake.env })
  await delivering.ready()
  delivering.log = fake.env.log
  delivering.watchOwned('no-such-share', '/data/z', [])
  // No data layer is open in this process, so the handler for this event rejects.
  fake.created[0].emit('add', '/data/z/a.txt')
  await waitFor(() => fake.warned.some((l) => l.includes('owned-folder fs event failed')), 5000, { label: 'the failed event logged' })
  t.pass('the failed event was logged, not thrown')
  await delivering.close()
  t.ok(fake.created[0].closed, 'and the close stopped the watcher')
  t.execution(() => delivering.watchOwned('late', '/data/late', []), 'an arm after the close is a no-op')
  t.is(fake.created.length, 1, 'that built no watcher')
})

// REGRESSION (FIX-WATCH-1: the early stop on the close path set no flag, so a mount probe or a peer
// coming online could arm a new watch while the data layer was closing).
test('REGRESSION (FIX-WATCH-1: a watch armed after the early stop outlived it): nothing arms once halted', async (t) => {
  const fake = fakeWatchEnv()
  const watchers = new FileWatchers('fw-halted', { env: fake.env })
  await watchers.ready()
  watchers.watchOwned('s1', '/data/a', [])
  watchers.halt()
  t.ok(fake.created[0].closed, 'the halt stopped the live watcher')
  watchers.watchOwned('s2', '/data/b', [])
  watchers.watchMirror({ spaceId: 'sp', shareId: 's3', mountPath: '/data/c' })
  watchers.watchLoose('sp', '/data/d.txt')
  t.is(fake.created.length, 1, 'no watcher is built after the halt')
  await watchers.close()
})
