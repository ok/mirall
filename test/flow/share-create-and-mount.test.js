import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'

test('one command creates a folder and mounts it, and both halves reach the other peer', async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'one.txt'), 'hello')
  fs.writeFileSync(path.join(folder, 'two.txt'), 'world')

  const res = await A.request('share:create-and-mount', { spaceId, name: 'Notes', mountPath: folder })
  t.ok(res.share?.id, 'the share record comes back')
  t.is(res.mount.mountPath, folder, 'and so does the mount the same call created')

  const shares = await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === res.share.id))
  t.is(shares.find((s) => s.id === res.share.id).name, 'Notes', 'the folder is advertised to the space')

  const files = await B.until(
    'share:list-files',
    { spaceId, ownerKey: aKey, shareId: res.share.id },
    (f) => Array.isArray(f?.entries) && f.entries.length >= 2,
  )
  t.alike(files.entries.map((f) => f.relPath).sort(), ['one.txt', 'two.txt'], 'with content behind it')
})

// REGRESSION (FIX-R05-9: the create and the mount are two writes to two bees, and the first one
// REPLICATES. When the second failed, the compensating delete lived in the renderer — so anything
// that ended that process first left a folder advertised to every co-member with nothing behind it,
// invisible to every owner-side pass and impossible for the user to delete.)
//
// maxFilesPerShare makes the failure deterministic AND puts it where the defect lives: the
// admission gate runs after the replicated publish, behind the folder walk.
test('REGRESSION (FIX-R05-9): a mount that fails leaves nothing advertised to the space', async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', flags: { maxFilesPerShare: 1 } })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)

  const folder = mkTmpDir(t)
  for (const name of ['a.txt', 'b.txt', 'c.txt']) fs.writeFileSync(path.join(folder, name), name)

  await t.exception(
    () => A.request('share:create-and-mount', { spaceId, name: 'TooBig', mountPath: folder }),
    /limited to/i,
    'the admission gate refuses the folder',
  )

  t.alike(await A.request('share:list', { spaceId }), [], 'the owner is left with no folder')
  // The peer's view is the one the defect was defined by: a share row it can never list files from.
  t.alike(await B.request('share:list', { spaceId }), [], 'and no co-member was ever told about one')
})

test('a refused mount path publishes nothing at all', async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)

  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'one.txt'), 'hello')
  const first = await A.request('share:create-and-mount', { spaceId, name: 'Notes', mountPath: folder })

  // A file, not a folder: refused by the write probe, which runs before the share record exists
  // at all — so the refusal must leave the space's view of Alice completely unchanged.
  await t.exception(
    () => A.request('share:create-and-mount', {
      spaceId, name: 'Notes Again', mountPath: path.join(folder, 'one.txt'),
    }),
    undefined,
    'the path is refused',
  )

  const own = await A.request('share:list', { spaceId })
  t.is(own.length, 1, 'only the folder that succeeded exists')
  t.is(own[0].id, first.share.id)
})
