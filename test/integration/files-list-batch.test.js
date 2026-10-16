import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import b4a from 'b4a'
import { freshPeer } from '../helpers/store.js'
import { createSpace } from '../../src/shared/spaces/space-lifecycle.js'
import { createBee } from '../../src/shared/core/store.js'
import {
  initDownloads,
  markDownloaded,
  markVerified,
  getDownloadedPath,
  listLooseDownloadClaims,
  listOwnedSources,
  listVerifiedRecordsForShare,
  pruneDownloadClaims,
  verdictForClaim,
} from '../../src/shared/transfer/files.js'
import { listFiles } from '../../src/shared/transfer/file-listing.js'
import { initPendingTransfers, listPendingForSpace } from '../../src/shared/transfer/pending-transfers.js'
import { shareDownloadPhase, listPeerWithMeta, watchedCatalogVersion } from '../../src/shared/transfer/overlay/share-downloads.js'
import { LOOSE_SHARE_ID } from '../../src/shared/transfer/transfer-id.js'
import { advertise } from '../../src/shared/shares/own-catalog.js'

// The loose listing takes its data-layer calls injected, so read COUNTS are assertable without
// instrumenting a bee. The space itself is real: the listing reads the local drive and own catalog.
async function setup(t) {
  const ctx = await freshPeer(t)
  await initDownloads()
  await initPendingTransfers()
  const space = await createSpace('Aurora')
  return { ...ctx, spaceId: space.spaceId }
}

const memberNo = (i) => ({ publicKey: 'peer' + i + 'pub', displayName: 'P' + i, driveKey: 'dk' + i, looseCatalogKey: String(i).repeat(64) })
const rows = (tag, n) => Array.from({ length: n }, (_, j) => ({ relPath: `${tag}-${j}.bin`, size: 10, contentHash: `${tag}h${j}`, mtime: 0 }))

// catalogVersion answers null, so no member is ever served from the listing memo here. The catalog
// reader receives each member's loose share, so `entriesFor` is keyed by its owner.
function countingDeps({ entriesFor, claims = new Map(), verified = new Map(), verdict = null } = {}) {
  const calls = { listPeer: 0, claimScans: 0, verifiedScans: 0, verdicts: 0, prunes: [] }
  return {
    calls,
    listPeer: async (spaceId, share) => { calls.listPeer++; return { entries: entriesFor(share), complete: true, version: 1 } },
    listPendingForSpace: async () => [],
    isOwnerOnline: () => true,
    transferPhase: () => null,
    verdictForClaim: (spaceId, drivePath, rec) => {
      calls.verdicts++
      return verdict ? verdict(drivePath, rec) : { downloaded: false, prune: false, reason: rec ? null : 'no-claim', stat: null }
    },
    listVerifiedRecordsForShare: async () => { calls.verifiedScans++; return verified },
    listLooseDownloadClaims: async () => { calls.claimScans++; return claims },
    listOwnedSources: async () => new Map(),
    pruneDownloadClaims: async (spaceId, drivePaths) => { calls.prunes.push(...drivePaths); return drivePaths.length },
    catalogVersion: async () => null,
  }
}

test('reads do not scale with rows: two range scans regardless of listing size', async (t) => {
  const ctx = await setup(t)
  const members = [memberNo(1), memberNo(2), memberNo(3)]
  for (const n of [1, 200, 2000]) {
    const deps = countingDeps({ entriesFor: (s) => rows(s.owner + n, n) })
    const files = (await listFiles(ctx.spaceId, members, { deps })).entries
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
  const files = (await listFiles(ctx.spaceId, [memberNo(1)], { deps })).entries
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
    entriesFor: (s) => shared(s.owner === 'peer1pub' ? 'A' : 'B'),
    claims,
  })
  deps.verdictForClaim = (spaceId, drivePath, rec, hash) => {
    deps.calls.verdicts++
    return hash === rec.hash
      ? { downloaded: true, prune: false, reason: null, stat: { size: 10, mtimeMs: 0, ino: 1 } }
      : { downloaded: false, prune: true, reason: 'content-changed-upstream', stat: null }
  }
  const files = (await listFiles(ctx.spaceId, [memberNo(1), memberNo(2)], { deps })).entries
  t.alike(deps.calls.prunes, [], 'the claim member 2 holds survives member 1’s stale verdict')
  t.is(files.find((f) => f.hash === 'B')?.status, 'downloaded')
  t.is(files.find((f) => f.hash === 'A')?.status, 'remote')
})

// A loose listing is complete unless a member who is online could not be read in full. An offline
// member's read always stalls, and its rows already say so; an empty catalog read in full is not
// a stall, though the folder rule would call it incomplete.
test('the loose listing is incomplete exactly when an online member\'s read stalled or threw', async (t) => {
  const ctx = await setup(t)
  const listed = async (patch) => {
    const deps = countingDeps({ entriesFor: () => rows('c', 1) })
    patch(deps)
    return await listFiles(ctx.spaceId, [memberNo(1)], { deps })
  }
  const stalled = (deps) => { deps.listPeer = async () => ({ entries: [], complete: false, stalled: true }) }

  t.is((await listed(() => {})).complete, true, 'a full read')
  t.is((await listed(stalled)).complete, false, 'an online member whose read stalled')
  t.is((await listed((deps) => { stalled(deps); deps.isOwnerOnline = () => false })).complete, true, 'the same member, offline')
  t.is((await listed((deps) => { deps.listPeer = async () => { throw new Error('boom') } })).complete, false, 'an online member whose read threw')
  t.is((await listed((deps) => { deps.listPeer = async () => ({ entries: [], complete: false, stalled: false }) })).complete, true,
    'an empty catalog read in full')

  const memoDeps = countingDeps({ entriesFor: () => rows('m', 1) })
  memoDeps.catalogVersion = async () => 1 // the version countingDeps' reads report
  await listFiles(ctx.spaceId, [memberNo(2)], { deps: memoDeps })
  const fromMemo = await listFiles(ctx.spaceId, [memberNo(2)], { deps: memoDeps })
  t.is(memoDeps.calls.listPeer, 1, 'the second listing is served from the memo')
  t.is(fromMemo.complete, true, 'a memo hit')
})

// REGRESSION (FIX-B3-SOURCES: the own-source scan had no error handling, so one unreadable
// downloads-bee read rejected files:list and the storage summary along with it.)
test('REGRESSION (FIX-B3-SOURCES): an unreadable source scan lists own rows without a localPath', async (t) => {
  const ctx = await setup(t)
  await advertise(ctx.spaceId, LOOSE_SHARE_ID, 'own.bin', { size: 4, mtime: 1, contentHash: 'h'.repeat(64) })
  const deps = countingDeps({ entriesFor: () => [] })
  deps.listOwnedSources = async () => { throw new Error('bee closed') }
  const listing = await listFiles(ctx.spaceId, [], { deps })
  const own = listing.entries.find((f) => f.path === '/own.bin')
  t.ok(own, 'the listing still answers, own row included')
  t.is(own.localPath, null, 'with no source to name')
})

test('member order is the dedupe tie-break', async (t) => {
  const ctx = await setup(t)
  const deps = countingDeps({ entriesFor: () => [{ relPath: 'twin.bin', size: 10, contentHash: 'same', mtime: 0 }] })
  const files = (await listFiles(ctx.spaceId, [memberNo(2), memberNo(1)], { deps })).entries
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
    listPeer: listPeerWithMeta,
    listPendingForSpace,
    isOwnerOnline: () => true,
    transferPhase: shareDownloadPhase,
    verdictForClaim,
    listVerifiedRecordsForShare,
    listLooseDownloadClaims,
    listOwnedSources,
    pruneDownloadClaims,
    catalogVersion: watchedCatalogVersion,
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

  let row = (await listFiles(ctx.spaceId, [member], { deps })).entries.find((f) => f.path === '/a.bin')
  t.is(row.status, 'downloaded')
  t.is(row.verified, true, 'the prefetched record vouches for the landed file')

  fs.writeFileSync(landed, 'aaaaa')
  row = (await listFiles(ctx.spaceId, [member], { deps })).entries.find((f) => f.path === '/a.bin')
  t.is(row.status, 'modified', 'a size that moved lists as modified')

  fs.rmSync(landed)
  row = (await listFiles(ctx.spaceId, [member], { deps })).entries.find((f) => f.path === '/a.bin')
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

  const row = (await listFiles(ctx.spaceId, [member], { deps })).entries.find((f) => f.path === '/v.bin')
  t.is(row.status, 'detached', 'not on the device while the volume is away, and says so')
  t.is(row.localPath, detached, 'the row names where the copy is')
  t.alike(prunes, [], 'nothing pruned')
  t.is(await getDownloadedPath(ctx.spaceId, '/v.bin'), detached, 'the claim survives for the volume to come back to')
})

const oneRow = async (ctx, deps) => (await listFiles(ctx.spaceId, [memberNo(1)], { deps })).entries[0]

test('REGRESSION (FIX-LOOSE-OFFLINE-PARTIAL): an unhashed row holding partial bytes from an offline owner keeps paused-offline', async (t) => {
  const ctx = await setup(t)
  const unhashed = () => [{ relPath: 'r-0.bin', size: 10, contentHash: null, mtime: 0 }]
  const withPending = (bytesTransferred, online) => {
    const deps = countingDeps({ entriesFor: unhashed })
    deps.listPendingForSpace = async () => [{ filePath: '/r-0.bin', ownerKey: 'peer1pub', bytesTransferred }]
    deps.isOwnerOnline = () => online
    return deps
  }
  const row = await oneRow(ctx, withPending(4096, false))
  t.is(row.status, 'paused-offline', 'the partial keeps its Discard')
  t.is(row.pendingBytes, 4096)
  t.ok(row.transferId, 'the Discard has a transfer id to address')
  t.is((await oneRow(ctx, withPending(0, false))).status, 'unavailable', 'no bytes on disk → nothing to manage')
  t.is((await oneRow(ctx, withPending(4096, true))).status, 'preparing', 'a reachable owner re-hashing wins')
})

// A claim, a live slot and a pending row are keyed by name: another member's same-named file must
// never read as this owner's while the owner is still hashing theirs.
test('an unhashed entry never takes another owner\'s same-named claim, transfer or pending row', async (t) => {
  const ctx = await setup(t)
  const deps = countingDeps({
    entriesFor: () => [{ relPath: 'r-0.bin', size: 10, contentHash: null, mtime: 0 }],
    verdict: () => ({ downloaded: true, prune: false, reason: null, stat: null }),
  })
  deps.transferPhase = () => 'active'
  deps.isOwnerOnline = () => false
  deps.listPendingForSpace = async () => [{ filePath: '/r-0.bin', ownerKey: 'someone-else', bytesTransferred: 4096 }]
  const row = await oneRow(ctx, deps)
  t.is(deps.calls.verdicts, 0, 'the claim is not asked without a hash to tie it to this owner')
  t.is(row.status, 'unavailable')
  t.is(row.localPath, null, 'no copy of this owner\'s file is on the device')
})

test('an error row carries its code and no bytes; a downloading row carries its bytes and no stale code', async (t) => {
  const ctx = await setup(t)
  const withPending = (pendingRow, active) => {
    const deps = countingDeps({ entriesFor: () => rows('r', 1) })
    deps.listPendingForSpace = async () => [{ filePath: '/r-0.bin', ownerKey: 'peer1pub', ...pendingRow }]
    deps.transferPhase = () => (active ? 'active' : null)
    return deps
  }
  const error = await oneRow(ctx, withPending({ errorCode: 'EHASHMISMATCH', bytesTransferred: 10 }, false))
  t.is(error.status, 'error')
  t.is(error.errorCode, 'EHASHMISMATCH')
  t.is(error.pendingBytes, undefined)
  const active = await oneRow(ctx, withPending({ bytesTransferred: 77 }, true))
  t.is(active.status, 'downloading')
  t.is(active.pendingBytes, 77)
  const activeOverError = await oneRow(ctx, withPending({ errorCode: 'X' }, true))
  t.is(activeOverError.status, 'downloading')
  t.is(activeOverError.errorCode, undefined)
})

// REGRESSION (FIX-DLTO-R9: a claim is keyed by name, so member B's different notes.txt read
// "Drive not connected · Saved to …" from member A's copy on an unplugged drive, though B's file
// was never downloaded; and A's row kept offering Download while A was offline.)
test('REGRESSION (FIX-DLTO-R9: only the content a claim names reads as its copy on a missing drive)', async (t) => {
  const ctx = await setup(t)
  const away = path.join(ctx.tmpDir('vol'), 'ejected-usb', 'Mirall') // never created: the drive is unplugged
  const copy = path.join(away, 'notes.txt')
  await markDownloaded(ctx.spaceId, '/notes.txt', copy, { hash: 'hA', destDir: away })
  const prunes = []
  const deps = productionDepsWith({
    listPeer: async (spaceId, share) => ({ entries: [{ relPath: 'notes.txt', size: 10, contentHash: share.owner === 'peer1pub' ? 'hA' : 'hB', mtime: 0 }], complete: true, version: 1 }),
    catalogVersion: async () => null,
    transferPhase: () => null,
    pruneDownloadClaims: async (spaceId, drivePaths) => { prunes.push(...drivePaths); return drivePaths.length },
  })
  const listed = async () => (await listFiles(ctx.spaceId, [memberNo(1), memberNo(2)], { deps })).entries

  let files = await listed()
  const a = files.find((f) => f.hash === 'hA')
  const b = files.find((f) => f.hash === 'hB')
  t.is(a.status, 'detached', 'A\'s file: its copy is on the drive that is away')
  t.is(a.localPath, copy, 'and the row says where')
  t.is(b.status, 'remote', 'B\'s same-named file was never downloaded')
  t.is(b.localPath, null, 'and names no copy')
  t.alike(prunes, [], 'the claim is kept for the drive to come back to')

  deps.isOwnerOnline = (key) => key !== 'peer1pub'
  files = await listed()
  t.is(files.find((f) => f.hash === 'hA').status, 'unavailable', 'with A offline nothing can fetch A\'s file')
  t.is(await getDownloadedPath(ctx.spaceId, '/notes.txt'), copy, 'and the claim still survives')
})
