import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes, waitForFile } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'
import { waitFor } from '../helpers/poll.js'

// The back end's own file watchers, end to end: no file event is delivered by the test. The owner
// adds, edits and deletes files on disk, and the member's mirror follows; the member edits a mirrored
// file, and the mirror's watcher has the owner's version restored beside a conflicted copy. Both
// peers run their real watchers, so this holds under every transport, including a back end started
// with no window at all (MIRALL_TEST_IPC_TRANSPORT=headless).
const REAL_WATCHERS = { testFileWatchersOff: false }

function holds(file, bytes) {
  try { return fs.readFileSync(file).equals(bytes) } catch { return false }
}

test('files changed on disk reach the other peer through the back end\'s own watchers', { timeout: scaled(240000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice', flags: REAL_WATCHERS })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', flags: REAL_WATCHERS })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'seed.txt'), 'seed')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  await waitForFile(path.join(mirrorDir, 'seed.txt'), { present: true })

  const listing = () => B.request('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id })
  const sizeOn = (files, relPath) => files?.entries?.find((e) => e.relPath === relPath)?.size

  // An add in a new subfolder: written on disk, nothing else.
  const added = patternedBytes(24 * 1024, 7)
  fs.mkdirSync(path.join(folder, 'sub'))
  fs.writeFileSync(path.join(folder, 'sub', 'added.bin'), added)
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => sizeOn(f, 'sub/added.bin') === added.length, { ms: 90000 })
  await waitForFile(path.join(mirrorDir, 'sub', 'added.bin'), { present: true, ms: 90000 })
  t.ok(fs.readFileSync(path.join(mirrorDir, 'sub', 'added.bin')).equals(added), 'an added file reaches the mirror byte-exact')

  // An edit in place.
  const edited = patternedBytes(40 * 1024, 11)
  fs.writeFileSync(path.join(folder, 'seed.txt'), edited)
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => sizeOn(f, 'seed.txt') === edited.length, { ms: 90000 })
  await waitFor(() => holds(path.join(mirrorDir, 'seed.txt'), edited), 90000, { label: 'the edit on the mirror' })
  t.pass('an edit reaches the mirror')

  // A delete.
  fs.unlinkSync(path.join(folder, 'sub', 'added.bin'))
  await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && !f.entries.some((e) => e.relPath === 'sub/added.bin'), { ms: 90000 })
  await waitForFile(path.join(mirrorDir, 'sub', 'added.bin'), { present: false, ms: 90000 })
  t.pass('a delete removes the file from the mirror')

  // The member edits a mirrored file: the mirror's watcher asks for the walk that keeps the edit
  // aside and puts the owner's bytes back.
  const mirrored = path.join(mirrorDir, 'seed.txt')
  fs.writeFileSync(mirrored, 'a local edit')
  const conflicted = path.join(mirrorDir, 'seed (conflicted copy).txt')
  await waitForFile(conflicted, { present: true, ms: 90000 })
  t.is(fs.readFileSync(conflicted, 'utf8'), 'a local edit', 'the member\'s edit is kept as a conflicted copy')
  await waitFor(() => holds(mirrored, edited), 90000, { label: 'the owner\'s version restored' })
  t.pass('and the owner\'s version is back')

  t.ok((await listing()).entries.every((e) => e.relPath !== 'seed (conflicted copy).txt'), 'the copy stays local to the member')

  // A worker with its own watchers serves no injected file event: no client can feed it one.
  const ghost = path.join(folder, 'ghost.txt')
  await t.exception(A.request('event:owned-folder-fs-event', { shareId: share.id, action: 'add', relPath: 'ghost.txt', absPath: ghost }),
    /Unknown command/, 'an injected owned-folder event is refused as an unknown request')
  await t.exception(B.request('event:foreign-folder-fs-event', { spaceId, shareId: share.id, action: 'change', relPath: 'seed.txt', absPath: mirrored }),
    /Unknown command/, 'and so is a mirror one')
})
