import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir, patternedBytes } from '../helpers/fixtures.js'

// Mirroring a foreign folder exercises the materialize engine's connectivity
// gate (the deadlock fixed this session: a freshly-replicated drive has only
// metadata, so the engine must stream the blob on demand while the owner is
// online — it must NOT skip because the blob isn't cached yet). A successful
// download here is the end-to-end regression for that fix.
test('B mirrors A’s owned folder; files materialize to disk with matching bytes', { timeout: 90000 }, async (t) => {
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).publicKey

  // A publishes a folder with two files.
  const share = await A.request('share:create', { spaceId, name: 'Photos' })
  const folder = mkTmpDir(t)
  const picBytes = patternedBytes(20 * 1024, 11)
  fs.writeFileSync(path.join(folder, 'pic.bin'), picBytes)
  fs.writeFileSync(path.join(folder, 'readme.txt'), 'hello mirror')
  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  // B sees the share, then mirrors it to a local dir.
  await B.until('share:list', { spaceId }, (list) => list.some((s) => s.id === share.id))
  const mirrorDir = mkTmpDir(t)
  const active = B.waitFor('event:foreign-folder-mount-status',
    (m) => m.shareId === share.id && m.status === 'active')
  await B.request('foreign-folder:mount', { spaceId, shareId: share.id, ownerKey: aKey, mountPath: mirrorDir })
  await active

  // The blobs streamed from A (owner online) and landed on B's disk, byte-exact.
  t.ok(fs.existsSync(path.join(mirrorDir, 'pic.bin')), 'pic.bin materialized')
  t.ok(fs.readFileSync(path.join(mirrorDir, 'pic.bin')).equals(picBytes), 'pic.bin bytes match source')
  t.is(fs.readFileSync(path.join(mirrorDir, 'readme.txt'), 'utf8'), 'hello mirror')

  // No stray .partial left behind.
  t.absent(fs.readdirSync(mirrorDir).some((f) => f.endsWith('.partial')), 'no leftover .partial')

  // A mirrored file reads as synced, not "available to download".
  const listed = await B.until('share:list-files', { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => f?.entries?.find((e) => e.relPath === 'pic.bin')?.status === 'synced', { ms: 30000 })
  t.is(listed.entries.find((e) => e.relPath === 'pic.bin').status, 'synced', 'mirrored file shows synced, not available')
})
