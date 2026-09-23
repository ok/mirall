import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { createBee } from '../../src/shared/core/store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import {
  initDownloads,
  markDownloaded,
  markVerified,
  listLooseDownloadClaims,
  listVerifiedRecordsForShare,
  pruneDownloadClaims,
  verdictForClaim,
} from '../../src/shared/transfer/files.js'
import { listFiles } from '../../src/shared/transfer/file-listing.js'
import { initPendingTransfers, listPendingForSpace, recordPending, recordPendingError } from '../../src/shared/transfer/pending-transfers.js'
import { looseCatalogVersion, looseListPeer, looseTransferActive } from '../../src/shared/transfer/backends/overlay/loose-downloads.js'
import { dropPeerCatalog } from '../../src/shared/shares/peer-catalog.js'
import { forgetListingMemo } from '../../src/shared/transfer/listing-memo.js'
import { takeIncompleteListSpaces } from '../../src/shared/transfer/list-deficits.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

// A catalog is read only when the listing memo cannot vouch for it; everything else a row shows is
// read live. Asserted by read COUNTS through the injected catalog reader, never by wall time.
async function setup(t, config = {}) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), inPlaceFilesEnabled: true, ...config })
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId }
}

const memberNo = (i) => ({ publicKey: 'peer' + i + 'pub', displayName: 'P' + i, driveKey: 'dk' + i, looseCatalogKey: String(i).repeat(64) })

// Every member's catalog sits at `versions[publicKey]`; listPeer reads it whole unless `stalls` names
// the member, in which case the read comes back incomplete, as a stalled drain does.
function scriptedDeps({ versions, stalls = new Set() }) {
  const reads = {}
  return {
    reads,
    total: () => Object.values(reads).reduce((a, b) => a + b, 0),
    listPeer: async (spaceId, member) => {
      reads[member.publicKey] = (reads[member.publicKey] || 0) + 1
      const version = versions[member.publicKey]
      const entries = [{ relPath: member.displayName + '-v' + version + '.bin', size: 1, contentHash: member.publicKey + version, mtime: 0 }]
      return { entries, complete: !stalls.has(member.publicKey), version }
    },
    listPendingForSpace: async () => [],
    isOwnerOnline: () => true,
    transferActive: () => false,
    verdictForClaim: () => ({ downloaded: false, prune: false, reason: 'no-claim', stat: null }),
    listVerifiedRecordsForShare: async () => new Map(),
    listLooseDownloadClaims: async () => new Map(),
    pruneDownloadClaims: async () => 0,
    catalogVersion: async (spaceId, member) => versions[member.publicKey],
  }
}

test('an unchanged catalog is served without a read; a moved one is read, alone', async (t) => {
  const ctx = await setup(t)
  const members = [memberNo(1), memberNo(2), memberNo(3)]
  const versions = { peer1pub: 1, peer2pub: 1, peer3pub: 1 }
  const deps = scriptedDeps({ versions })

  await listFiles(ctx.spaceId, members, { deps })
  t.is(deps.total(), 3, 'the first listing reads every member')
  const warm = await listFiles(ctx.spaceId, members, { deps })
  await listFiles(ctx.spaceId, members, { deps })
  t.is(deps.total(), 3, 'two more listings read nothing')
  t.alike(warm.map((f) => f.path).sort(), ['/P1-v1.bin', '/P2-v1.bin', '/P3-v1.bin'], 'and still list every member')

  versions.peer2pub = 2
  const moved = await listFiles(ctx.spaceId, members, { deps })
  t.alike(deps.reads, { peer1pub: 1, peer2pub: 2, peer3pub: 1 }, 'only the appended catalog is read again')
  t.ok(moved.some((f) => f.path === '/P2-v2.bin'), 'with its new entries')
})

test('the backstop reads a catalog every Nth listing whatever its version', async (t) => {
  const ctx = await setup(t, { listFullReadEvery: 3 })
  const deps = scriptedDeps({ versions: { peer1pub: 1 } })
  for (let i = 0; i < 7; i++) await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  t.is(deps.reads.peer1pub, 3, 'listings 1, 4 and 7 read; the two between each are skips')
})

test('listFullReadEvery of 1 reads on every listing', async (t) => {
  const ctx = await setup(t, { listFullReadEvery: 1 })
  const deps = scriptedDeps({ versions: { peer1pub: 1 } })
  for (let i = 0; i < 3; i++) await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  t.is(deps.reads.peer1pub, 3)
})

test('an incomplete read is never memoised', async (t) => {
  const ctx = await setup(t)
  const members = [memberNo(1), memberNo(2)]
  const deps = scriptedDeps({ versions: { peer1pub: 1, peer2pub: 1 }, stalls: new Set(['peer1pub']) })
  for (let i = 1; i <= 3; i++) {
    await listFiles(ctx.spaceId, members, { deps })
    t.is(deps.reads.peer1pub, i, `listing ${i} reads the stalled member again`)
  }
  t.is(deps.reads.peer2pub, 1, 'the healthy member is served from the memo meanwhile')
})

test('a catalog whose live version is unknown is read every time', async (t) => {
  const ctx = await setup(t)
  const deps = scriptedDeps({ versions: { peer1pub: 1 } })
  deps.catalogVersion = async () => null
  for (let i = 0; i < 3; i++) await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  t.is(deps.reads.peer1pub, 3)
})

test('a read that throws is not memoised and flags the space', async (t) => {
  const ctx = await setup(t)
  const deps = scriptedDeps({ versions: { peer1pub: 1 } })
  await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  deps.catalogVersion = async () => 2
  deps.listPeer = async () => { deps.reads.peer1pub++; throw new Error('boom') }
  takeIncompleteListSpaces()
  const files = await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  t.is(files.length, 0, 'the failed member contributes no rows')
  t.ok(takeIncompleteListSpaces().includes(ctx.spaceId), 'flagged for the convergence re-poke')
  deps.catalogVersion = async () => 1
  await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  t.is(deps.reads.peer1pub, 3, 'the old version’s memo was dropped when the read began')
})

test('forgetting a space drops its memo', async (t) => {
  const ctx = await setup(t)
  const deps = scriptedDeps({ versions: { peer1pub: 1 } })
  await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  forgetListingMemo(ctx.spaceId)
  await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  t.is(deps.reads.peer1pub, 2)
})

// The real catalog reader over a local bee whose blocks are present, counted: the version the
// drain returns is the one the next listing compares against.
async function localCatalog(ctx) {
  const bee = createBee('memo-catalog-' + ctx.spaceId.slice(0, 8))
  await bee.ready()
  const put = (name, contentHash) => bee.put('file/' + LOOSE_SHARE_ID + '/' + name, { size: 4, mtime: 1, contentHash })
  const member = { publicKey: 'localpub', displayName: 'Local', driveKey: 'dk', looseCatalogKey: b4a.toString(bee.core.key, 'hex') }
  return { bee, put, member }
}

function realDeps(presence) {
  const reads = { n: 0 }
  return {
    reads,
    listPeer: async (...args) => { reads.n++; return await looseListPeer(...args) },
    listPendingForSpace,
    isOwnerOnline: () => presence.online,
    transferActive: looseTransferActive,
    verdictForClaim,
    listVerifiedRecordsForShare,
    listLooseDownloadClaims,
    pruneDownloadClaims,
    catalogVersion: looseCatalogVersion,
  }
}

test('every local input to a row is live over memoised entries', async (t) => {
  const ctx = await setup(t)
  const { bee, put, member } = await localCatalog(ctx)
  t.teardown(() => bee.close())
  await put('a.bin', 'ha')
  await put('b.bin', 'hb')
  await put('c.bin', 'hc')
  const presence = { online: true }
  const deps = realDeps(presence)
  const row = async (p) => (await listFiles(ctx.spaceId, [member], { deps })).find((f) => f.path === p)

  t.is((await row('/a.bin')).status, 'remote')
  t.is(deps.reads.n, 1)

  const landed = path.join(ctx.tmpDir('dl'), 'a.bin')
  fs.writeFileSync(landed, 'aaaa')
  await markDownloaded(ctx.spaceId, '/a.bin', landed, { hash: 'ha' })
  await markVerified(ctx.spaceId, LOOSE_SHARE_ID + '|a.bin', 'ha', { local: landed, stat: fs.statSync(landed) })
  const downloaded = await row('/a.bin')
  t.is(downloaded.status, 'downloaded', 'a landed download')
  t.is(downloaded.verified, true)

  fs.writeFileSync(landed, 'aaaaa')
  t.is((await row('/a.bin')).status, 'modified', 'an edit on disk')

  await recordPending(ctx.spaceId, '/b.bin', { ownerKey: member.publicKey, size: 4 })
  t.is((await row('/b.bin')).status, 'paused-interrupted', 'a pending row')
  await recordPendingError(ctx.spaceId, '/b.bin', 'E_TEST')
  t.is((await row('/b.bin')).status, 'error', 'a pending error')

  presence.online = false
  t.is((await row('/c.bin')).status, 'unavailable', 'the owner going away')
  t.is((await row('/b.bin')).status, 'error', 'still the error while the owner is away')
  t.is((await row('/a.bin')).status, 'modified')
  t.is(deps.reads.n, 1, 'none of it read the catalog again')
})

test('an append after the listing moves the version past the memo and is read', async (t) => {
  const ctx = await setup(t)
  const { bee, put, member } = await localCatalog(ctx)
  t.teardown(() => bee.close())
  await put('a.bin', 'ha')
  const deps = realDeps({ online: true })

  await listFiles(ctx.spaceId, [member], { deps })
  await listFiles(ctx.spaceId, [member], { deps })
  t.is(deps.reads.n, 1, 'converged')

  await put('late.bin', 'hl')
  const files = await listFiles(ctx.spaceId, [member], { deps })
  t.is(deps.reads.n, 2, 'the appended catalog is read')
  t.alike(files.map((f) => f.path).sort(), ['/a.bin', '/late.bin'])
})

// A skip is only safe while the owner's next append will poke the listing, so a catalog whose loose
// watch is gone is read — which is also what arms the watch again.
test('a catalog with no armed append watch is read, and the read re-arms it', async (t) => {
  const ctx = await setup(t)
  const { bee, put, member } = await localCatalog(ctx)
  t.teardown(() => bee.close())
  await put('a.bin', 'ha')
  const deps = realDeps({ online: true })

  await listFiles(ctx.spaceId, [member], { deps })
  await listFiles(ctx.spaceId, [member], { deps })
  t.is(deps.reads.n, 1, 'converged')

  dropPeerCatalog(member.looseCatalogKey)
  await listFiles(ctx.spaceId, [member], { deps })
  t.is(deps.reads.n, 2, 'the unwatched catalog is read')
  await listFiles(ctx.spaceId, [member], { deps })
  t.is(deps.reads.n, 2, 'and skipped again once the read re-armed the watch')
})

test('a backstop read that stalls keeps listing the memoised entries', async (t) => {
  const ctx = await setup(t, { listFullReadEvery: 2 })
  const members = [memberNo(1)]
  const deps = scriptedDeps({ versions: { peer1pub: 1 } })
  const first = await listFiles(ctx.spaceId, members, { deps })
  await listFiles(ctx.spaceId, members, { deps })
  t.is(deps.reads.peer1pub, 1, 'one skip before the backstop comes due')
  deps.listPeer = async (spaceId, member) => {
    deps.reads[member.publicKey]++
    return { entries: [], complete: false, version: null }
  }
  const backstop = await listFiles(ctx.spaceId, members, { deps })
  t.is(deps.reads.peer1pub, 2, 'the backstop read ran')
  t.alike(backstop.map((f) => f.path), first.map((f) => f.path), 'and its stall did not empty the listing')
  await listFiles(ctx.spaceId, members, { deps })
  t.is(deps.reads.peer1pub, 2, 'the kept memo serves the next listing')
})

test('a member who left the space is dropped from the memo', async (t) => {
  const ctx = await setup(t)
  const deps = scriptedDeps({ versions: { peer1pub: 1, peer2pub: 1 } })
  await listFiles(ctx.spaceId, [memberNo(1), memberNo(2)], { deps })
  await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  await listFiles(ctx.spaceId, [memberNo(1), memberNo(2)], { deps })
  t.alike(deps.reads, { peer1pub: 1, peer2pub: 2 }, 'the returning member is read afresh')
})
