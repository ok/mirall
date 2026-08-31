import test from 'brittle'
import fs from 'bare-fs'
import os from 'bare-os'
import path from 'bare-path'
import { listOverlayShareFiles } from '../../src/shared/shares/share-listing.js'
import { claimVerdict } from '../../src/shared/transfer/download-claim.js'
import { pathFromMount } from '../../src/shared/transfer/path-guard.js'
import { consumerRowStatusFor, unhashedStatusFor } from '../../src/shared/transfer/transfer-status.js'
import { transferIdFor } from '../../src/shared/transfer/transfer-id.js'

const SPACE = 'sp1'
const SHARE = { id: 'sh1', name: 'Docs', owner: 'peer' }

// The listing takes its data-layer calls injected, so read COUNTS are assertable without
// instrumenting a bee: production passes nothing, a test passes these.
function countingDeps({ claims = new Map(), verified = new Map(), downloaded = () => false } = {}) {
  const calls = { claimScans: 0, verifiedScans: 0, verdicts: 0, prunes: [] }
  return {
    calls,
    getLocalPublicKeyHex: () => 'me',
    isOwnerOnline: () => true,
    getOwnedMount: async () => null,
    getForeignMount: async () => null,
    listPendingForSpace: async () => [],
    foreignFetchActive: () => false,
    overlayHasTransfer: () => false,
    claimedPathFor: (drivePath, rec) => rec?.localPath || '/downloads/' + drivePath.split('/').pop(),
    listDownloadClaimsForShare: async () => { calls.claimScans++; return claims },
    listVerifiedForShare: async () => { calls.verifiedScans++; return verified },
    verdictForClaim: (spaceId, drivePath, rec) => {
      calls.verdicts++
      return { downloaded: downloaded(drivePath, rec), prune: false, reason: null }
    },
    pruneDownloadClaims: async (spaceId, drivePaths) => { calls.prunes.push(...drivePaths); return drivePaths.length },
  }
}

const rows = (n) => Array.from({ length: n }, (_, i) => ({ relPath: `f${i}.txt`, size: 10, contentHash: 'h' + i, mtime: 0 }))
const backendFor = (entries) => ({
  listOwn: async () => ({ entries, total: entries.length, totalBytes: 0, complete: true }),
  listPeerWithMeta: async () => ({ entries, total: entries.length, totalBytes: 0, complete: true }),
})

test('reads do not scale with rows: two range scans regardless of listing size', async (t) => {
  for (const n of [1, 200, 2000]) {
    const deps = countingDeps()
    const res = await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(n)), deps)
    t.is(res.entries.length, n, `${n} rows rendered`)
    t.is(deps.calls.claimScans, 1, `${n} rows: exactly ONE claim scan`)
    t.is(deps.calls.verifiedScans, 1, `${n} rows: exactly ONE verified scan`)
  }
})

test('a mounted mirror reads only the verified namespace', async (t) => {
  const deps = countingDeps()
  deps.getForeignMount = async () => ({ enabled: true, mountPath: '/mnt/Docs' })
  await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(50)), deps)
  t.is(deps.calls.verifiedScans, 1)
  t.is(deps.calls.claimScans, 0, 'a mirror row never consults a download claim, so the scan is not issued')
})

test('an owner listing reads neither namespace', async (t) => {
  const deps = countingDeps()
  deps.getLocalPublicKeyHex = () => SHARE.owner
  deps.getOwnedMount = async () => ({ mountPath: '/src/Docs' })
  const res = await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(50)), deps)
  t.is(deps.calls.claimScans + deps.calls.verifiedScans, 0)
  t.is(res.entries[0].status, 'synced')
  t.is(res.entries[0].localPath, pathFromMount('/src/Docs', 'f0.txt'))
})

test('the scans are asked to retain only the rows this listing renders', async (t) => {
  const deps = countingDeps()
  const seen = {}
  deps.listVerifiedForShare = async (spaceId, shareId, opts) => { seen.verified = opts.keep; return new Map() }
  deps.listDownloadClaimsForShare = async (spaceId, shareName, opts) => { seen.claims = opts.keep; return new Map() }
  await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(3)), deps)
  t.alike([...seen.verified].sort(), ['f0.txt', 'f1.txt', 'f2.txt'], 'verified records are kept by relPath')
  t.alike([...seen.claims].sort(), ['/Docs/f0.txt', '/Docs/f1.txt', '/Docs/f2.txt'], 'claims are kept by drive path')
})

test('stale claims are collected during the pass and pruned ONCE after it', async (t) => {
  const deps = countingDeps()
  deps.verdictForClaim = (spaceId, drivePath) => ({
    downloaded: false, prune: drivePath.endsWith('f1.txt'), reason: 'local-file-gone',
  })
  const batches = []
  const inner = deps.pruneDownloadClaims
  deps.pruneDownloadClaims = async (spaceId, drivePaths) => { batches.push(drivePaths.length); return inner(spaceId, drivePaths) }
  await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(10)), deps)
  t.alike(batches, [1], 'exactly one prune call, carrying the one stale key — not one call per row')
  t.alike(deps.calls.prunes, ['/Docs/f1.txt'])
})

test('a listing with nothing stale issues no prune at all', async (t) => {
  const deps = countingDeps()
  let called = 0
  deps.pruneDownloadClaims = async () => { called++; return 0 }
  await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(10)), deps)
  t.is(called, 0)
})

test('a prune failure never fails the listing', async (t) => {
  const deps = countingDeps()
  deps.verdictForClaim = () => ({ downloaded: false, prune: true, reason: 'local-file-gone' })
  deps.pruneDownloadClaims = async () => { throw new Error('bee closed') }
  const res = await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(3)), deps)
  t.is(res.entries.length, 3, 'the rows are returned even though the cleanup threw')
})

test('an unsafe relPath skips its row without aborting the listing', async (t) => {
  const deps = countingDeps()
  deps.getForeignMount = async () => ({ enabled: true, mountPath: '/mnt/Docs' })
  const entries = [
    { relPath: 'ok.txt', size: 1, contentHash: 'h', mtime: 0 },
    { relPath: '../escape.txt', size: 1, contentHash: 'h', mtime: 0 },
  ]
  const res = await listOverlayShareFiles(SPACE, SHARE, backendFor(entries), deps)
  t.is(res.entries.length, 1)
  t.is(res.entries[0].relPath, 'ok.txt')
  t.is(res.total, 2, 'the count still reports what the catalog holds')
})

// The listing builds its own directory probe and hands the SAME one to every row, so the folder
// question reaches the filesystem once per folder however many rows resolve into it. Observed
// through verdictForClaim, which is where the probe is actually used.
test('every row of one listing shares one directory probe', async (t) => {
  const deps = countingDeps()
  const received = new Set()
  deps.verdictForClaim = (spaceId, drivePath, rec, hash, dirProbe) => {
    received.add(dirProbe)
    return { downloaded: false, prune: false, reason: 'volume-unavailable' }
  }
  await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(500)), deps)
  t.is(received.size, 1, '500 rows, one probe — not one per row')
  t.is(typeof [...received][0], 'function', 'and it is a real probe, not undefined')
})

test('the probe a listing hands out asks the filesystem once per folder', async (t) => {
  const deps = countingDeps()
  let probe = null
  deps.verdictForClaim = (spaceId, drivePath, rec, hash, dirProbe) => {
    probe = dirProbe
    return { downloaded: false, prune: false, reason: 'volume-unavailable' }
  }
  await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(3)), deps)
  const dir = path.join(os.tmpdir(), 'mirall-probe-' + Date.now().toString(36))
  t.is(probe(dir), false, 'absent folder')
  fs.mkdirSync(dir, { recursive: true })
  t.teardown(() => { try { fs.rmSync(dir, { recursive: true, force: true }) } catch {} })
  t.is(probe(dir), false, 'the pass keeps its answer even though the folder now exists')
})

test('each listing gets a fresh probe, so a remounted volume is seen on the next pass', async (t) => {
  const deps = countingDeps()
  const seen = []
  deps.verdictForClaim = (spaceId, drivePath, rec, hash, dirProbe) => {
    seen.push(dirProbe)
    return { downloaded: false, prune: false, reason: 'volume-unavailable' }
  }
  await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(2)), deps)
  await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(2)), deps)
  t.is(new Set(seen).size, 2, 'two listings, two probes — never module state that outlives a pass')
})

// ---------------------------------------------------------------------------
// Row parity across the whole decision space.
//
// `baselineRow` below is the pre-batching row rule transcribed verbatim from the point-read
// implementation: an await per claim read, a second read for the verified marker, a third for the
// landed path, and the claim pruned inline. It is an INDEPENDENT implementation of the same rule,
// so agreement across the matrix is what makes "no behaviour change" a property the suite holds
// rather than a claim the change asserts.
// ---------------------------------------------------------------------------

const CLAIMS = {
  none: null,
  current: { rec: { localPath: '/dl/f.txt', hash: 'h1' }, exists: true, dirExists: true, pinned: null, insidePinned: true },
  hashless: { rec: { localPath: '/dl/f.txt' }, exists: true, dirExists: true, pinned: null, insidePinned: true },
  'stale-hash': { rec: { localPath: '/dl/f.txt', hash: 'hOLD' }, exists: true, dirExists: true, pinned: null, insidePinned: true },
  gone: { rec: { localPath: '/dl/f.txt', hash: 'h1' }, exists: false, dirExists: true, pinned: null, insidePinned: true },
  detached: { rec: { localPath: '/vol/f.txt', hash: 'h1' }, exists: false, dirExists: false, pinned: null, insidePinned: true },
  outside: { rec: { localPath: '/other/f.txt', hash: 'h1' }, exists: true, dirExists: true, pinned: '/dl', insidePinned: false },
}
const VERIFIED = { match: 'h1', mismatch: 'hZ', absent: null }
const PENDING = { none: undefined, partial: { bytesTransferred: 5 }, error: { errorCode: 'EBAD', bytesTransferred: 0 } }

const entryOf = (w) => ({ relPath: 'f.txt', size: 10, contentHash: w.hashed ? 'h1' : null, mtime: 7 })
const claimedPathFor = (drivePath, rec) => rec?.localPath || '/downloads/' + path.basename(drivePath)

function baselineRow(w, mountPath) {
  const entry = entryOf(w)
  const out = { pruned: false }
  if (w.mirrored) {
    const abs = pathFromMount(mountPath, entry.relPath)
    if (statSizeOrNull(abs) === entry.size) {
      const verified = !!entry.contentHash && VERIFIED[w.verified] === entry.contentHash
      return { ...out, row: { status: 'synced', localPath: abs, verified } }
    }
    if (w.fetchActive) return { ...out, row: { status: 'downloading', localPath: null, pendingBytes: 0 } }
    if (!entry.contentHash) return { ...out, row: { status: unhashedStatusFor(w.ownerOnline), localPath: null } }
    return { ...out, row: { status: w.ownerOnline ? 'remote' : 'unavailable', localPath: null } }
  }
  const drivePath = '/' + SHARE.name + '/' + entry.relPath
  const world = CLAIMS[w.claim]
  let downloaded = false
  if (world) {
    if (!world.exists) out.pruned = world.dirExists
    else if (world.rec.hash && entry.contentHash && world.rec.hash !== entry.contentHash) out.pruned = true
    else if (world.pinned && !world.insidePinned) downloaded = false
    else downloaded = true
  }
  if (downloaded) {
    const verified = entry.contentHash ? VERIFIED[w.verified] === entry.contentHash : false
    return { ...out, row: { status: 'downloaded', localPath: claimedPathFor(drivePath, world.rec), verified } }
  }
  const row = consumerRowStatusFor({
    hashed: Boolean(entry.contentHash),
    isActive: w.active,
    pendingRow: PENDING[w.pending],
    ownerOnline: w.ownerOnline,
  })
  return { ...out, row: { ...row, localPath: null } }
}

function statSizeOrNull(absPath) {
  try { return fs.statSync(absPath).size } catch { return null }
}

// The shape listOverlayShareFiles pushes, with absent optional fields normalised so the two sides
// compare on value rather than on which of undefined/null the branch happened to produce.
function shaped(w, row) {
  const entry = entryOf(w)
  return {
    relPath: entry.relPath,
    size: entry.size,
    hash: entry.contentHash || '',
    mtime: entry.mtime,
    status: row.status,
    localPath: row.localPath ?? null,
    verified: row.verified || false,
    pendingBytes: row.pendingBytes ?? null,
    errorCode: row.errorCode ?? null,
    transferId: transferIdFor(SPACE, SHARE.id, entry.relPath),
  }
}

function worldDeps(w, mountPath) {
  const world = CLAIMS[w.claim]
  const drivePath = '/' + SHARE.name + '/f.txt'
  const pruned = []
  return {
    pruned,
    getLocalPublicKeyHex: () => 'me',
    isOwnerOnline: () => w.ownerOnline,
    getOwnedMount: async () => null,
    getForeignMount: async () => (w.mirrored ? { enabled: true, mountPath } : null),
    listPendingForSpace: async () => (PENDING[w.pending] ? [{ ...PENDING[w.pending], filePath: drivePath }] : []),
    foreignFetchActive: () => w.fetchActive,
    overlayHasTransfer: () => w.active,
    claimedPathFor,
    listDownloadClaimsForShare: async () => (world ? new Map([[drivePath, world.rec]]) : new Map()),
    listVerifiedForShare: async () => (VERIFIED[w.verified] ? new Map([['f.txt', VERIFIED[w.verified]]]) : new Map()),
    verdictForClaim: (spaceId, filePath, rec, currentHash) => (rec
      ? claimVerdict({ rec, currentHash, exists: world.exists, dirExists: world.dirExists, pinned: world.pinned, insidePinned: world.insidePinned })
      : claimVerdict({ rec: null })),
    pruneDownloadClaims: async (spaceId, drivePaths) => { pruned.push(...drivePaths); return drivePaths.length },
  }
}

function matrix() {
  const cells = []
  for (const mirrored of [true, false]) {
    for (const sizeMatch of mirrored ? [true, false] : [false]) {
      for (const fetchActive of mirrored ? [true, false] : [false]) {
        for (const claim of mirrored ? ['none'] : Object.keys(CLAIMS)) {
          for (const verified of Object.keys(VERIFIED)) {
            for (const hashed of [true, false]) {
              for (const ownerOnline of [true, false]) {
                for (const pending of mirrored ? ['none'] : Object.keys(PENDING)) {
                  for (const active of mirrored ? [false] : [true, false]) {
                    cells.push({ mirrored, sizeMatch, fetchActive, claim, verified, hashed, ownerOnline, pending, active })
                  }
                }
              }
            }
          }
        }
      }
    }
  }
  return cells
}

const describe = (w) => Object.entries(w).map(([k, v]) => k + '=' + v).join(' ')

test('every row of the decision space matches the pre-batching rule', async (t) => {
  const root = path.join(os.tmpdir(), 'mirall-listing-parity-' + Date.now().toString(36))
  const present = path.join(root, 'present')
  const empty = path.join(root, 'empty')
  fs.mkdirSync(present, { recursive: true })
  fs.mkdirSync(empty, { recursive: true })
  fs.writeFileSync(path.join(present, 'f.txt'), '0123456789')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  const cells = matrix()
  t.ok(cells.length > 500, `${cells.length} combinations covered`)
  let mismatches = 0
  let prunesChecked = 0
  for (const w of cells) {
    const mountPath = w.sizeMatch ? present : empty
    const expected = baselineRow(w, mountPath)
    const deps = worldDeps(w, mountPath)
    const res = await listOverlayShareFiles(SPACE, SHARE, backendFor([entryOf(w)]), deps)
    const gotRow = res.entries[0]
    const wantRow = shaped(w, expected.row)
    const got = { ...gotRow, localPath: gotRow.localPath ?? null, pendingBytes: gotRow.pendingBytes ?? null, errorCode: gotRow.errorCode ?? null }
    if (JSON.stringify(got) !== JSON.stringify(wantRow)) {
      mismatches++
      t.alike(got, wantRow, describe(w))
    }
    const wantPruned = expected.pruned ? ['/' + SHARE.name + '/f.txt'] : []
    if (JSON.stringify(deps.pruned) !== JSON.stringify(wantPruned)) {
      mismatches++
      t.alike(deps.pruned, wantPruned, 'prune: ' + describe(w))
    }
    if (expected.pruned) prunesChecked++
  }
  t.is(mismatches, 0, 'every combination renders the same row and prunes the same claims')
  t.ok(prunesChecked > 0, 'the matrix actually exercises the pruning branches')
})
