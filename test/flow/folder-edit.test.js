import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, mkStoreDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

const FLAGS = { overlayEnabled: true }

// The name lives on the owner's share record, so a rename is a write every member replicates. What
// this proves is the part a single peer cannot: the member sees the new name, and nothing else about
// the share moves with it — same id, same catalog, same files, no re-index.
test('a rename reaches the member and moves nothing else', { timeout: scaled(240000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: FLAGS })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'note.txt'), 'hello')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (list) => Array.isArray(list) && list.some((s) => s.id === share.id && s.name === 'Vault'), { ms: 60000 })
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'note.txt'), { ms: 60000 })

  const renamed = await A.request('share:rename', { spaceId, shareId: share.id, name: 'Olli’s Vault' })
  // record() is fire-and-forget by design, so the row lands just after the reply.
  await A.until('audit:list', { limit: 100 },
    (page) => page.entries.some((e) => e.kind === 'share.renamed'), { ms: 20000 })
  t.pass('the rename is on the record')
  t.is(renamed.id, share.id, 'the id is untouched — a rename is not a re-share')
  t.is(renamed.catalogKey, share.catalogKey, 'and so is the catalog key')
  t.is(renamed.name, 'Vault', 'and neither is the drive-path segment members key their claims by')
  t.is(renamed.displayName, 'Olli’s Vault', 'the label is the only thing that moved')

  const seen = await B.until('share:list', { spaceId },
    (list) => Array.isArray(list) && list.some((s) => s.id === share.id && s.displayName === 'Olli’s Vault'), { ms: 60000 })
  t.ok(seen, 'the member replicated the new label')
  t.is(seen.find((s) => s.id === share.id).name, 'Vault', 'while the name its download claims are keyed by held still')
  t.is(seen.filter((s) => s.id === share.id).length, 1, 'one share, not two')

  const files = await B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
  t.ok(files.entries.some((e) => e.relPath === 'note.txt'), 'the listing survived the rename')

  A.kill()
})

test('the owner cannot rename a folder onto a name it already uses', { timeout: scaled(120000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: FLAGS })
  const space = await A.request('space:create', { name: 'Aurora' })
  await A.request('share:create', { spaceId: space.spaceId, name: 'Vault', contentMode: 'overlay' })
  const second = await A.request('share:create', { spaceId: space.spaceId, name: 'Photos', contentMode: 'overlay' })

  await t.exception(() => A.request('share:rename', { spaceId: space.spaceId, shareId: second.id, name: 'Vault' }))
  const list = await A.request('share:list', { spaceId: space.spaceId })
  t.is(list.find((s) => s.id === second.id).name, 'Photos', 'the rejected rename changed nothing')

  await t.exception(() => A.request('share:rename', { spaceId: space.spaceId, shareId: second.id, name: '  ' }))
  A.kill()
})

// Moving a mirror moves the MOUNT, not the bytes: whoever moved the folder keeps them, and a fresh
// destination is simply refetched. What only two peers can prove is that the mirror keeps working
// afterwards — the owner is still its source, and the record it publishes still says so.
test('a member can move its mirror and it keeps syncing', { timeout: scaled(240000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', storage: mkStoreDir(t), flags: FLAGS })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', downloads: mkTmpDir(t), flags: FLAGS })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  const share = await A.request('share:create', { spaceId, name: 'Vault', contentMode: 'overlay' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'note.txt'), 'hello')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.some((e) => e.relPath === 'note.txt'), { ms: 60000 })

  const first = mkTmpDir(t)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: first })
  await B.until('foreign-folder:get', { spaceId, shareId: share.id },
    () => fs.existsSync(path.join(first, 'note.txt')), { ms: 120000 })

  const second = mkTmpDir(t)
  const moved = await B.request('foreign-folder:relocate', { spaceId, shareId: share.id, mountPath: second })
  t.is(moved.mount.mountPath, second, 'the mount points at the new folder')
  t.ok(fs.existsSync(path.join(first, 'note.txt')), 'and the old copy is left for the user to deal with')

  // The new destination is empty, so the mirror has to fetch it again — which is the honest
  // reading of "move the mount, not the bytes", and proves the synced Set did not come along.
  await B.until('foreign-folder:get', { spaceId, shareId: share.id },
    () => fs.existsSync(path.join(second, 'note.txt')), { ms: 120000 })
  t.is(fs.readFileSync(path.join(second, 'note.txt'), 'utf8'), 'hello', 'byte-exact at the new path')

  await B.until('audit:list', { limit: 100 },
    (page) => page.entries.some((e) => e.kind === 'mirror.relocated'), { ms: 20000 })
  t.pass('the move is on the record')

  A.kill()
})
