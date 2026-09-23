import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, waitForFile } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// CRIT-7 (flow) — a mirror is owner-authoritative. If the user edits a file inside their own
// mirror, the walk the mirror's disk watcher requests keeps the edit as a conflicted copy and
// restores the owner's version at the natural name. This documents (and guards) that local edits to
// mirrored files are NOT kept in place — so the UI must steer users away from editing inside a
// mirror.
//
// REGRESSION (FIX-462: a local-only edit does not move the owner's catalog version, so a converged
// mirror skipped every tick until the full-walk backstop — unless the folder view's listing asked
// for the walk. The revert must follow from the watcher's event alone: the poll and the backstop are
// set out of reach, nothing on the owner's side moves, and the wait reads the disk rather than a
// listing, which would itself request the walk.)
test('REGRESSION (FIX-462): a local edit to a mirrored file is reverted on the watcher event alone', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob', flags: { foreignPollIntervalMs: 600_000, foreignFullWalkEvery: 1_000_000 } })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'note.txt'), 'owner-authoritative-v1')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  const noteOnB = path.join(mirrorDir, 'note.txt')
  await waitForFile(noteOnB, { present: true })

  // The user tampers with the mirrored copy locally (no owner-side change), and main's watcher
  // reports it — injected here, as every flow test injects the owned side's events.
  fs.writeFileSync(noteOnB, 'tampered locally by Bob')
  await B.request('event:foreign-folder-fs-event',
    { spaceId, shareId: share.id, action: 'change', relPath: 'note.txt', absPath: noteOnB })

  const conflicted = path.join(mirrorDir, 'note (conflicted copy).txt')
  await waitForFile(conflicted, { present: true, ms: 60000 })
  t.is(fs.readFileSync(conflicted, 'utf8'), 'tampered locally by Bob', 'the edit is kept as a conflicted copy')
  await waitForFile(noteOnB, { present: true, ms: 60000 })
  t.is(fs.readFileSync(noteOnB, 'utf8'), 'owner-authoritative-v1', 'the owner version is back at the natural name')
})

// The ordinary path, with the watcher out of the picture: an owner-driven walk re-checks every entry
// it passes, so the tamper is caught by the hash mismatch on the walk the owner's next append runs.
test('a local edit to a mirrored file is reverted by the walk an owner append runs', { timeout: scaled(150000) }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey

  const share = await A.request('share:create', { spaceId, name: 'Docs' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'note.txt'), 'owner-authoritative-v1')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  await B.until('share:list', { spaceId }, (l) => l.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active', 90000)
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active
  const noteOnB = path.join(mirrorDir, 'note.txt')
  await waitForFile(noteOnB, { present: true })

  fs.writeFileSync(noteOnB, 'tampered locally by Bob')

  // Wake B's tick by having the owner replicate an unrelated new file; the same walk re-checks
  // note.txt, sees the hash mismatch, and fetches the owner's bytes back.
  fs.writeFileSync(path.join(folder, 'wake.txt'), 'tick trigger')
  await A.request('event:owned-folder-fs-event',
    { shareId: share.id, action: 'add', relPath: 'wake.txt', absPath: path.join(folder, 'wake.txt') })
  await waitForFile(path.join(mirrorDir, 'wake.txt'), { present: true, ms: 120000 })

  await waitForFile(path.join(mirrorDir, 'note (conflicted copy).txt'), { present: true, ms: 60000 })
  await waitForFile(noteOnB, { present: true, ms: 60000 })
  t.is(fs.readFileSync(noteOnB, 'utf8'), 'owner-authoritative-v1', 'local edit reverted to the owner version')
})
