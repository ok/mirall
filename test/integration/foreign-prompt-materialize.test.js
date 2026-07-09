import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { initialPublishScan } from '../../src/shared/folders/owned-folders.js'
import {
  initialMaterializeScan,
  startForeignLoop,
  stopForeignLoop,
  onPeerDriveChanged,
} from '../../src/shared/folders/foreign-folders.js'

async function waitForFile (p, present, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (fs.existsSync(p) === present) return true
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

async function waitForContent (p, expected, ms = 5000) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    try { if (fs.readFileSync(p, 'utf8') === expected) return true } catch {}
    await new Promise((r) => setTimeout(r, 50))
  }
  return false
}

// REGRESSION (FIX-MIRROR-PROMPT): owner-side changes used to reflect on the
// mirror disk only on the 30s poll, so a deletion/addition showed in the folder
// view (drive listing) long before it landed on disk. A peer-drive append now
// triggers a prompt materialize tick for active mirrors in that space.
test('a peer-drive change triggers a prompt materialize tick on active mirrors', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Docs', files: { 'a.txt': 'one' } })
  await startForeignLoop(ctx.mount)
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id))
  await initialMaterializeScan(ctx.mount)
  t.ok(fs.existsSync(path.join(ctx.mirrorPath, 'a.txt')), 'initial file mirrored')

  // The owner publishes a new file; without the append-driven trigger this would
  // sit until the next 30s poll.
  fs.writeFileSync(path.join(ctx.mountPath, 'b.txt'), 'two')
  await initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  onPeerDriveChanged(ctx.spaceId)

  t.ok(await waitForFile(path.join(ctx.mirrorPath, 'b.txt'), true), 'new file materialized promptly after the drive changed')
})

// REGRESSION (FIX-MIRROR-ECHO): an owner edit arriving within the echo guard's
// 30s TTL of the initial materialize used to be suppressed (the put-guard
// early-returned before the hash check), so the mirror kept the stale version.
// A changed hash must always re-download.
test('an owner edit shortly after materialize still propagates to the mirror', async (t) => {
  const ctx = await setupSelfMirror(t, { name: 'Docs', files: { 'f.txt': 'v1' } })
  await startForeignLoop(ctx.mount)
  t.teardown(() => stopForeignLoop(ctx.spaceId, ctx.share.id))
  await initialMaterializeScan(ctx.mount)
  t.is(fs.readFileSync(path.join(ctx.mirrorPath, 'f.txt'), 'utf8'), 'v1', 'initial version mirrored')

  // Edit immediately — well inside the old 30s guard window.
  fs.writeFileSync(path.join(ctx.mountPath, 'f.txt'), 'v2-edited')
  await initialPublishScan(ctx.spaceId, ctx.share.id, ctx.mountPath, [])

  onPeerDriveChanged(ctx.spaceId)

  t.ok(await waitForContent(path.join(ctx.mirrorPath, 'f.txt'), 'v2-edited'), 'edit re-materialized despite the recent write')
})
