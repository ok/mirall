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
  getDownloadedPath,
  listLooseDownloadClaims,
  listVerifiedRecordsForShare,
  pruneDownloadClaims,
  verdictForClaim,
} from '../../src/shared/transfer/files.js'
import { listFiles } from '../../src/shared/transfer/file-listing.js'
import { initPendingTransfers, listPendingForSpace } from '../../src/shared/transfer/pending-transfers.js'
import { looseCatalogVersion, looseListPeer, looseTransferActive } from '../../src/shared/transfer/backends/overlay/loose-downloads.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'

// The loose listing takes its data-layer calls injected, so read COUNTS are assertable without
// instrumenting a bee. The space itself is real: the listing reads the local drive and own catalog.
async function setup(t) {
  const ctx = await freshPeer(t)
  setRuntimeConfig({ ...getRuntimeConfig(), inPlaceFilesEnabled: true })
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId }
}

const memberNo = (i) => ({ publicKey: 'peer' + i + 'pub', displayName: 'P' + i, driveKey: 'dk' + i, looseCatalogKey: String(i).repeat(64) })
const rows = (tag, n) => Array.from({ length: n }, (_, j) => ({ relPath: `${tag}-${j}.bin`, size: 10, contentHash: `${tag}h${j}`, mtime: 0 }))

// catalogVersion answers null, so no member is ever served from the listing memo here.
function countingDeps({ entriesFor, claims = new Map(), verified = new Map(), verdict = null } = {}) {
  const calls = { listPeer: 0, claimScans: 0, verifiedScans: 0, verdicts: 0, prunes: [] }
  return {
    calls,
    listPeer: async (spaceId, member) => { calls.listPeer++; return { entries: entriesFor(member), complete: true, version: 1 } },
    listPendingForSpace: async () => [],
    isOwnerOnline: () => true,
    transferActive: () => false,
    verdictForClaim: (spaceId, drivePath, rec) => {
      calls.verdicts++
      return verdict ? verdict(drivePath, rec) : { downloaded: false, prune: false, reason: rec ? null : 'no-claim', stat: null }
    },
    listVerifiedRecordsForShare: async () => { calls.verifiedScans++; return verified },
    listLooseDownloadClaims: async () => { calls.claimScans++; return claims },
    pruneDownloadClaims: async (spaceId, drivePaths) => { calls.prunes.push(...drivePaths); return drivePaths.length },
    catalogVersion: async () => null,
  }
}

test('reads do not scale with rows: two range scans regardless of listing size', async (t) => {
  const ctx = await setup(t)
  const members = [memberNo(1), memberNo(2), memberNo(3)]
  for (const n of [1, 200, 2000]) {
    const deps = countingDeps({ entriesFor: (m) => rows(m.publicKey + n, n) })
    const files = await listFiles(ctx.spaceId, members, { deps })
    t.is(files.length, 3 * n, `${n} rows per member rendered`)
    t.is(deps.calls.claimScans, 1, `${n} rows: exactly ONE claim scan`)
    t.is(deps.calls.verifiedScans, 1, `${n} rows: exactly ONE verified scan`)
    t.is(deps.calls.verdicts, 3 * n, `${n} rows: one in-memory verdict per row`)
    t.is(deps.calls.listPeer, 3, `${n} rows: one catalog read per member`)
  }
})

test('the scans are asked to retain only the rows this listing renders', async (t) => {
  const ctx = await setup(t)
  const deps = countingDeps({ entriesFor: () => rows('r', 2) })
  const seen = {}
  deps.listVerifiedRecordsForShare = async (spaceId, shareId, opts) => { seen.verified = [shareId, [...opts.keep].sort()]; return new Map() }
  deps.listLooseDownloadClaims = async (spaceId, opts) => { seen.claims = [...opts.keep].sort(); return new Map() }
  await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  t.alike(seen.verified, [LOOSE_SHARE_ID, ['r-0.bin', 'r-1.bin']], 'loose verified records, kept by relPath')
  t.alike(seen.claims, ['/r-0.bin', '/r-1.bin'], 'claims, kept by drive path')
})

test('stale claims are pruned once, after the rows, and the rows still render', async (t) => {
  const ctx = await setup(t)
  const claims = new Map([['/p-0.bin', { localPath: '/gone/p-0.bin' }], ['/p-2.bin', { localPath: '/gone/p-2.bin' }]])
  const deps = countingDeps({
    entriesFor: () => rows('p', 3),
    claims,
    verdict: (drivePath, rec) => ({ downloaded: false, prune: !!rec, reason: rec ? 'local-file-gone' : 'no-claim', stat: null }),
  })
  const files = await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  t.alike(deps.calls.prunes, ['/p-0.bin', '/p-2.bin'], 'one batch, in row order')
  t.alike(files.map((f) => f.status), ['remote', 'remote', 'remote'])
})

// REGRESSION (FIX-SHARED-NAME-CLAIM: a claim is keyed by name, not by owner, so two members
// advertising different content under one name read the same claim, and the row pass pruned it for
// whichever member it no longer matched — deleting the copy the other member's row showed as on
// this device, in member order.)
test('REGRESSION (FIX-SHARED-NAME-CLAIM): a claim another row reads as downloaded is never pruned', async (t) => {
  const ctx = await setup(t)
  const shared = (hash) => [{ relPath: 'same.bin', size: 10, contentHash: hash, mtime: 0 }]
  const claims = new Map([['/same.bin', { localPath: '/dl/same.bin', hash: 'B' }]])
  const deps = countingDeps({
    entriesFor: (m) => shared(m.publicKey === 'peer1pub' ? 'A' : 'B'),
    claims,
  })
  deps.verdictForClaim = (spaceId, drivePath, rec, hash) => {
    deps.calls.verdicts++
    return hash === rec.hash
      ? { downloaded: true, prune: false, reason: null, stat: { size: 10, mtimeMs: 0, ino: 1 } }
      : { downloaded: false, prune: true, reason: 'content-changed-upstream', stat: null }
  }
  const files = await listFiles(ctx.spaceId, [memberNo(1), memberNo(2)], { deps })
  t.alike(deps.calls.prunes, [], 'the claim member 2 holds survives member 1’s stale verdict')
  t.is(files.find((f) => f.hash === 'B')?.status, 'downloaded')
  t.is(files.find((f) => f.hash === 'A')?.status, 'remote')
})

test('member order is the dedupe tie-break', async (t) => {
  const ctx = await setup(t)
  const deps = countingDeps({ entriesFor: () => [{ relPath: 'twin.bin', size: 10, contentHash: 'same', mtime: 0 }] })
  const files = await listFiles(ctx.spaceId, [memberNo(2), memberNo(1)], { deps })
  t.is(files.length, 1)
  t.is(files[0].owner.publicKey, 'peer2pub', 'the first member listed wins a tie')
  t.is(files[0].sharedByCount, 1)
})

test('the loose claim scan skips folder-share claims under the same space', async (t) => {
  const ctx = await setup(t)
  // Loose names that sort just before, just after and between the folder subtrees the scan steps over.
  const loose = ['/Docs.txt', '/Docs0', '/Zeta', '/a.txt', '/zz']
  const folder = ['/Docs/a.txt', '/Docs/b/c.txt', '/Zeta/x', '/b/y']
  for (const p of [...loose, ...folder]) await markDownloaded(ctx.spaceId, p, '/dl' + p, { hash: 'h' })
  const other = await createSpace('Borealis')
  await markDownloaded(other.spaceId, '/b.txt', '/dl/b.txt', { hash: 'h' })
  t.alike([...(await listLooseDownloadClaims(ctx.spaceId)).keys()].sort(), [...loose].sort())
  t.alike([...(await listLooseDownloadClaims(ctx.spaceId, { keep: new Set(['/zzz']) })).keys()], [], 'keep bounds retention')
})

// A member whose catalog is a local bee with its blocks present: the real reader, the real claim
// and verified namespaces and the real disk.
async function localCatalogMember(ctx, names) {
  const bee = createBee('local-catalog-' + ctx.spaceId.slice(0, 8))
  await bee.ready()
  for (const [name, contentHash] of names) await bee.put('file/' + LOOSE_SHARE_ID + '/' + name, { size: 4, mtime: 1, contentHash })
  const key = b4a.toString(bee.core.key, 'hex')
  await bee.close()
  return { publicKey: 'localpub', displayName: 'Local', driveKey: 'dk', looseCatalogKey: key }
}

function productionDepsWith(overrides) {
  return {
    listPeer: looseListPeer,
    listPendingForSpace,
    isOwnerOnline: () => true,
    transferActive: looseTransferActive,
    verdictForClaim,
    listVerifiedRecordsForShare,
    listLooseDownloadClaims,
    pruneDownloadClaims,
    catalogVersion: looseCatalogVersion,
    ...overrides,
  }
}

test('a deleted download lists as remote and its claim is gone once the listing resolves', async (t) => {
  const ctx = await setup(t)
  const member = await localCatalogMember(ctx, [['a.bin', 'ha']])
  const landed = path.join(ctx.tmpDir('dl'), 'a.bin')
  fs.writeFileSync(landed, 'aaaa')
  await markDownloaded(ctx.spaceId, '/a.bin', landed, { hash: 'ha' })
  await markVerified(ctx.spaceId, LOOSE_SHARE_ID + '|a.bin', 'ha', { local: landed, stat: fs.statSync(landed) })
  const deps = productionDepsWith({})

  let row = (await listFiles(ctx.spaceId, [member], { deps })).find((f) => f.path === '/a.bin')
  t.is(row.status, 'downloaded')
  t.is(row.verified, true, 'the prefetched record vouches for the landed file')

  fs.writeFileSync(landed, 'aaaaa')
  row = (await listFiles(ctx.spaceId, [member], { deps })).find((f) => f.path === '/a.bin')
  t.is(row.status, 'modified', 'a size that moved lists as modified')

  fs.rmSync(landed)
  row = (await listFiles(ctx.spaceId, [member], { deps })).find((f) => f.path === '/a.bin')
  t.is(row.status, 'remote')
  t.is(await getDownloadedPath(ctx.spaceId, '/a.bin'), null, 'the deferred prune landed before listFiles resolved')
})

test('REGRESSION (FIX-CLAIM-ORDER): a claim whose download folder is gone is kept', async (t) => {
  const ctx = await setup(t)
  const member = await localCatalogMember(ctx, [['v.bin', 'hv']])
  const detached = path.join(ctx.tmpDir('vol'), 'ejected', 'v.bin')
  await markDownloaded(ctx.spaceId, '/v.bin', detached, { hash: 'hv' })
  const prunes = []
  const deps = productionDepsWith({ pruneDownloadClaims: async (spaceId, drivePaths) => { prunes.push(...drivePaths); return drivePaths.length } })

  const row = (await listFiles(ctx.spaceId, [member], { deps })).find((f) => f.path === '/v.bin')
  t.is(row.status, 'remote', 'not on the device while the volume is away')
  t.alike(prunes, [], 'nothing pruned')
  t.is(await getDownloadedPath(ctx.spaceId, '/v.bin'), detached, 'the claim survives for the volume to come back to')
})
