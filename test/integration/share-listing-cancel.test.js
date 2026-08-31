import test from 'brittle'
import { listOverlayShareFiles } from '../../src/shared/shares/share-listing.js'
import { createCancellation } from '../../src/shared/core/cancellation.js'

const SPACE = 'sp1'
const SHARE = { id: 'sh1', name: 'Docs', owner: 'peer' }

// The same injected-deps harness share-listing-batch.test.js uses: production passes nothing, a test
// passes these, and the counters make "the work never started" assertable rather than inferred.
function countingDeps() {
  const calls = { claimScans: 0, verifiedScans: 0, mountReads: 0, prunes: [] }
  return {
    calls,
    getLocalPublicKeyHex: () => 'me',
    isOwnerOnline: () => true,
    getOwnedMount: async () => { calls.mountReads++; return null },
    getForeignMount: async () => { calls.mountReads++; return null },
    listPendingForSpace: async () => [],
    foreignFetchActive: () => false,
    overlayHasTransfer: () => false,
    claimedPathFor: (drivePath, rec) => rec?.localPath || '/downloads/' + drivePath.split('/').pop(),
    listDownloadClaimsForShare: async () => { calls.claimScans++; return new Map() },
    listVerifiedForShare: async () => { calls.verifiedScans++; return new Map() },
    verdictForClaim: () => ({ downloaded: false, prune: false, reason: null }),
    pruneDownloadClaims: async (spaceId, drivePaths) => { calls.prunes.push(...drivePaths); return drivePaths.length },
  }
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ relPath: `f${i}.txt`, size: 10, contentHash: 'h' + i, mtime: 0 }))
const backendFor = (entries, onRead = null) => ({
  listOwn: async () => ({ entries, total: entries.length, totalBytes: 0, complete: true }),
  listPeerWithMeta: async () => {
    onRead?.()
    return { entries, total: entries.length, totalBytes: 0, complete: true }
  },
})

test('a signal aborted before the call does no work at all', async (t) => {
  const cancellation = createCancellation()
  cancellation.abort()
  const deps = countingDeps()
  await t.exception(
    listOverlayShareFiles(SPACE, SHARE, backendFor(rows(10)), deps, { signal: cancellation.signal }),
    /cancelled/,
    'it throws rather than returning an empty listing a view would render as "nothing shared"',
  )
  t.is(deps.calls.mountReads, 0, 'no mount reads')
  t.is(deps.calls.claimScans + deps.calls.verifiedScans, 0, 'and neither range scan was issued')
})

// The checkpoint that pays. For a peer share the catalog read is network-bound and carries its own
// timeout, so a listing whose view is gone can otherwise hold everything after it open for seconds.
test('an abort during the catalog read stops before the mounts and the scans', async (t) => {
  const cancellation = createCancellation()
  const deps = countingDeps()
  const backend = backendFor(rows(1000), () => cancellation.abort())
  await t.exception(
    listOverlayShareFiles(SPACE, SHARE, backend, deps, { signal: cancellation.signal }),
    /cancelled/,
  )
  t.is(deps.calls.mountReads, 0, 'the mount reads that follow the catalog read never ran')
  t.is(deps.calls.claimScans + deps.calls.verifiedScans, 0, 'nor did the prefetch scans')
})

test('an abort after the prefetch stops before any row is built', async (t) => {
  const cancellation = createCancellation()
  const deps = countingDeps()
  deps.listDownloadClaimsForShare = async () => { deps.calls.claimScans++; cancellation.abort(); return new Map() }
  await t.exception(
    listOverlayShareFiles(SPACE, SHARE, backendFor(rows(500)), deps, { signal: cancellation.signal }),
    /cancelled/,
  )
  t.is(deps.calls.claimScans, 1, 'the scan that aborted did run')
  t.alike(deps.calls.prunes, [], 'but the row pass never started, so it collected nothing to prune')
})

// Cancellation is advisory and opt-in: 85 handlers pass nothing, and the listing must behave exactly
// as it did before the signal existed.
test('no signal is exactly the behaviour before cancellation existed', async (t) => {
  const deps = countingDeps()
  const res = await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(10)), deps)
  t.is(res.entries.length, 10)
  t.is(deps.calls.claimScans, 1, 'the batched read pattern is untouched')
  t.is(deps.calls.verifiedScans, 1)
})

test('a null signal is not an abort', async (t) => {
  const deps = countingDeps()
  const res = await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(3)), deps, { signal: null })
  t.is(res.entries.length, 3)
})

// The row loop is synchronous, so an abort raised while it runs cannot be observed inside it. This
// pins that as INTENDED rather than as an oversight: a per-row check would be dead code, and if the
// loop ever regains an await this test is where the assumption breaks.
test('a listing already past its last checkpoint completes rather than half-building', async (t) => {
  const cancellation = createCancellation()
  const deps = countingDeps()
  deps.verdictForClaim = () => { cancellation.abort(); return { downloaded: false, prune: false, reason: null } }
  const res = await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(50)), deps, { signal: cancellation.signal })
  t.is(res.entries.length, 50, 'every row is built — a partial listing would be worse than a late one')
})
