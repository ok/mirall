import test from 'brittle'
import fs from 'fs'
import path from 'path'
import { localTestnet } from '../helpers/testnet.js'
import { launchPeer, connectInSpace } from '../helpers/peer.js'
import { mkTmpDir } from '../helpers/fixtures.js'
import { scaled } from '../helpers/timing.js'

// Overlay serves straight from the source file, so sharing a folder grows neither the owner's nor a
// browsing peer's app storage by the file bytes. What does grow is the catalog, and each side
// reports it on the space's row: the owner as its own catalog, the peer as a member's. Only a real
// run crosses the worker IPC on both.
const partsSum = (info) => info.spaces.reduce((n, s) => n + s.ownCatalogBytes + s.memberCatalogBytes, 0)
  + info.indexBytes + info.activityLogBytes + info.downloadHistoryBytes + info.historyBytes + info.otherBytes
const rowOf = (info, spaceId) => info.spaces.find((s) => s.spaceId === spaceId)

// Other is the remainder, so the parts meet the total exactly unless the estimates overshoot it.
function assertSumsToTotal(t, info, who) {
  if (info.otherBytes > 0) t.is(partsSum(info), info.totalDiskUsage, `the ${who} breakdown sums to its total`)
  else t.ok(partsSum(info) >= info.totalDiskUsage, `the ${who} estimates overshoot the total, and other is 0`)
}

test('storage breakdown: sharing and browsing a folder imports no file bytes', async (t) => {
  t.timeout(scaled(120000))
  const bootstrap = await localTestnet(t)
  const A = await launchPeer(t, { bootstrap, displayName: 'Alice' })
  const B = await launchPeer(t, { bootstrap, displayName: 'Bob' })
  const spaceId = await connectInSpace(t, A, B)
  const aKey = (await A.request('profile:get')).personKey
  const aBefore = await A.request('storage:info')
  const bBefore = await B.request('storage:info')

  const FILES = 5_000_000
  const share = await A.request('share:create', { spaceId, name: 'Notes' })
  const folder = mkTmpDir(t)
  fs.writeFileSync(path.join(folder, 'a.bin'), Buffer.alloc(3_000_000, 1))
  fs.writeFileSync(path.join(folder, 'b.bin'), Buffer.alloc(2_000_000, 2))
  // Enough entries that the catalog clears the store's size-estimate granularity.
  const NOTES = 200
  for (let i = 0; i < NOTES; i++) fs.writeFileSync(path.join(folder, `note-${i}.md`), `# ${i}`)

  const scanDone = A.waitFor('event:owned-folder-scan-completed', (m) => m.shareId === share.id)
  await A.request('owned-folder:mount', { spaceId, shareId: share.id, mountPath: folder })
  await scanDone

  const aAfter = await A.request('storage:info')
  assertSumsToTotal(t, aAfter, 'owner')
  t.ok(aAfter.folderBytes >= aAfter.totalDiskUsage, 'the data folder holds the store')
  t.ok(rowOf(aAfter, spaceId).ownCatalogBytes > 0, 'the owner sees its catalog on the space row')
  t.ok(aAfter.totalDiskUsage - aBefore.totalDiskUsage < FILES / 2, 'the owner imported no file bytes')

  await B.until(
    'share:list-files',
    { spaceId, ownerKey: aKey, shareId: share.id },
    (f) => Array.isArray(f?.entries) && f.entries.length >= 2 + NOTES,
  )

  const bAfter = await B.request('storage:info')
  t.ok(bAfter.totalDiskUsage - bBefore.totalDiskUsage < FILES / 2, `a peer replicating the catalog holds no file bytes (grew ${bAfter.totalDiskUsage - bBefore.totalDiskUsage})`)
  assertSumsToTotal(t, bAfter, 'peer')
  t.ok(rowOf(bAfter, spaceId).memberCatalogBytes > 0, 'the peer reports the replicated catalog as a member catalog of the space')
})
