import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { listOverlayShareFiles } from '../../src/shared/shares/share-listing.js'
import { claimVerdict } from '../../src/shared/transfer/download-claim.js'
import { pathFromMount } from '../../src/shared/folders/path-guard.js'
import { consumerRowStatusFor, unhashedStatusFor } from '../../src/shared/transfer/transfer-status.js'
import { transferIdFor } from '../../src/shared/transfer/transfer-id.js'
import { tmpDir, tmpPath } from '../helpers/bare-tmp.js'

const SPACE = 'sp1'
const SHARE = { id: 'sh1', name: 'Docs', owner: 'peer' }

// The listing takes its data-layer calls injected, so read COUNTS are assertable without
// instrumenting a bee: production passes nothing, a test passes these.
function countingDeps({ claims = new Map(), verified = new Map(), downloaded = () => false } = {}) {
  const calls = { claimScans: 0, verifiedScans: 0, verdicts: 0, prunes: [], walkRequests: 0 }
  return {
    calls,
    getLocalPublicKeyHex: () => 'me',
    isOwnerOnline: () => true,
    getOwnedMount: async () => null,
    getForeignMount: async () => null,
    listPendingForSpace: async () => [],
    foreignFetchActive: () => false,
    requestMirrorWalk: () => { calls.walkRequests++ },
    overlayHasTransfer: () => false,
    claimedPathFor: (drivePath, rec) => rec?.localPath || '/downloads/' + drivePath.split('/').pop(),
    listDownloadClaimsForShare: async () => { calls.claimScans++; return claims },
    listVerifiedRecordsForShare: async () => { calls.verifiedScans++; return verified },
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
  deps.listVerifiedRecordsForShare = async (spaceId, shareId, opts) => { seen.verified = opts.keep; return new Map() }
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
  const dir = tmpPath('mirall-probe')
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
// `baselineRow` below is the row rule written out a second time, independently of the listing: the
// claim ladder, the verified-copy fingerprint and the mirror's size fallback, each in its own words.
// Agreement across the matrix is what makes the rule a property the suite holds rather than a claim
// the change asserts.
// ---------------------------------------------------------------------------

// Claim paths under LANDED resolve to a real file in the test's own folder, so a downloaded row has
// something for its verified record to fingerprint; the others are never on disk by design.
const LANDED = '<landed>'
const CLAIMS = {
  none: null,
  current: { rec: { localPath: LANDED, hash: 'h1' }, exists: true, dirExists: true, pinned: null, insidePinned: true },
  hashless: { rec: { localPath: LANDED }, exists: true, dirExists: true, pinned: null, insidePinned: true },
  'stale-hash': { rec: { localPath: '/dl/f.txt', hash: 'hOLD' }, exists: true, dirExists: true, pinned: null, insidePinned: true },
  gone: { rec: { localPath: '/dl/f.txt', hash: 'h1' }, exists: false, dirExists: true, pinned: null, insidePinned: true },
  detached: { rec: { localPath: '/vol/f.txt', hash: 'h1' }, exists: false, dirExists: false, pinned: null, insidePinned: true },
  outside: { rec: { localPath: '/other/f.txt', hash: 'h1' }, exists: true, dirExists: true, pinned: '/dl', insidePinned: false },
}
// The verified record for the row, described against the file the row points at: `match` is the
// record that file's landing wrote, `edited` the same record after a local write moved its mtime,
// `moved` one whose inode alone differs (a copy or restore of the same bytes), `unlocal` one written
// before records named their path, `elsewhere` one written for another path (the other writer),
// `stale` one for an older content.
const VERIFIED = ['match', 'edited', 'moved', 'unlocal', 'elsewhere', 'stale', 'absent']
const PENDING = { none: undefined, partial: { bytesTransferred: 5 }, error: { errorCode: 'EBAD', bytesTransferred: 0 } }

const entryOf = (w) => ({ relPath: 'f.txt', size: 10, contentHash: w.hashed ? 'h1' : null, mtime: 7 })
const claimedPathFor = (drivePath, rec) => rec?.localPath || '/downloads/' + path.basename(drivePath)
// A pre-existing user file at the natural name forces the mirror onto a sibling, recorded in
// mount.renamedPaths. The dimension the matrix was missing, and the one the bug lived in.
const RENAMED_LEAF = 'f (1).txt'

function claimWorld(w, landed) {
  const world = CLAIMS[w.claim]
  if (!world) return null
  return { ...world, rec: { ...world.rec, localPath: world.rec.localPath === LANDED ? landed : world.rec.localPath } }
}

// The row's own local path, in the form its writer records it: mount-relative for a mirror, the
// claim's absolute path for a download.
function rowLocal(w, landed) {
  if (w.mirrored) return w.renamed ? RENAMED_LEAF : 'f.txt'
  return claimWorld(w, landed)?.rec.localPath ?? null
}

function recordFor(w, fingerprintOf, landed) {
  if (w.verified === 'absent') return null
  const local = rowLocal(w, landed)
  const fp = fingerprintOf(local)
  const rec = { hash: 'h1', at: Date.now(), local, mtime: fp.mtime, ino: fp.ino }
  if (w.verified === 'edited') return { ...rec, mtime: fp.mtime - 1000 }
  if (w.verified === 'moved') return { ...rec, ino: fp.ino + 1 }
  if (w.verified === 'unlocal') return { ...rec, local: null }
  if (w.verified === 'elsewhere') return { ...rec, local: '/somewhere/else/f.txt' }
  if (w.verified === 'stale') return { ...rec, hash: 'hZ' }
  return rec
}

// The verified-copy rule, transcribed independently of verified-copy.js: a record for this file at
// the current content still fingerprints it (verified), or its size moved (modified), or — on a
// mirror, whose next pass re-hashes — its mtime moved (modified); any other move is drift. Anything
// else proves nothing and leaves the row to what the disk says.
function copyReading(rec, stat, contentHash, size, local, rehashed) {
  if (!rec || !stat || !contentHash || rec.hash !== contentHash) return 'unproven'
  if (rec.local !== null && rec.local !== local) return 'unproven'
  const sameMtime = Math.floor(stat.mtimeMs) === rec.mtime
  const sameIno = !rec.ino || !stat.ino || Number(stat.ino) === rec.ino
  if (stat.size === size && sameMtime && sameIno) return 'verified'
  if (stat.size !== size || (rehashed && !sameMtime)) return 'modified'
  return 'drifted'
}

function onDevice(status, localPath, reading) {
  if (reading === 'modified') return { status: 'modified', localPath, verified: false }
  return { status, localPath, verified: reading === 'verified' }
}

function baselineRow(w, mountPath, rec, landed) {
  const entry = entryOf(w)
  const out = { pruned: false }
  if (w.mirrored) {
    const local = rowLocal(w, landed)
    const abs = pathFromMount(mountPath, local)
    const stat = statOrNull(abs)
    const reading = copyReading(rec, stat, entry.contentHash, entry.size, local, true)
    if (reading !== 'unproven' || stat?.size === entry.size) {
      return { ...out, walk: reading === 'modified' || reading === 'drifted', row: { ...onDevice('synced', abs, reading), mirrored: true } }
    }
    // An in-flight mirror fetch only counts while the owner is reachable: with them away the fetch
    // is parked on the overlay's peer wait, not pulling anything.
    if (w.fetchActive && w.ownerOnline) return { ...out, row: { status: 'downloading', localPath: null, pendingBytes: 0, mirrored: true } }
    if (!entry.contentHash) return { ...out, row: { status: unhashedStatusFor(w.ownerOnline), localPath: null, mirrored: true } }
    return { ...out, row: { status: w.ownerOnline ? 'remote' : 'unavailable', localPath: null, mirrored: true } }
  }
  const drivePath = '/' + SHARE.name + '/' + entry.relPath
  const world = claimWorld(w, landed)
  let downloaded = false
  if (world) {
    if (!world.exists) out.pruned = world.dirExists
    else if (world.rec.hash && entry.contentHash && world.rec.hash !== entry.contentHash) out.pruned = true
    else if (world.pinned && !world.insidePinned) downloaded = false
    else downloaded = true
  }
  if (downloaded) {
    const localPath = claimedPathFor(drivePath, world.rec)
    const reading = copyReading(rec, statOrNull(localPath), entry.contentHash, entry.size, localPath, false)
    return { ...out, row: onDevice('downloaded', localPath, reading) }
  }
  const row = consumerRowStatusFor({
    hashed: Boolean(entry.contentHash),
    isActive: w.active,
    pendingRow: PENDING[w.pending],
    ownerOnline: w.ownerOnline,
  })
  return { ...out, row: { ...row, localPath: null } }
}

function statOrNull(absPath) {
  try { return fs.statSync(absPath) } catch { return null }
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
    mirrored: row.mirrored || false,
    pendingBytes: row.pendingBytes ?? null,
    errorCode: row.errorCode ?? null,
    transferId: transferIdFor(SPACE, SHARE.id, entry.relPath),
  }
}

function worldDeps(w, mountPath, rec, landed) {
  const world = claimWorld(w, landed)
  const drivePath = '/' + SHARE.name + '/f.txt'
  const pruned = []
  const reads = { verified: 0, claims: 0, walkRequests: 0 }
  return {
    pruned,
    reads,
    getLocalPublicKeyHex: () => 'me',
    isOwnerOnline: () => w.ownerOnline,
    getOwnedMount: async () => null,
    getForeignMount: async () => (w.mirrored
      ? { enabled: true, mountPath, ...(w.renamed ? { renamedPaths: { 'f.txt': RENAMED_LEAF } } : {}) }
      : null),
    listPendingForSpace: async () => (PENDING[w.pending] ? [{ ...PENDING[w.pending], filePath: drivePath }] : []),
    foreignFetchActive: () => w.fetchActive,
    requestMirrorWalk: () => { reads.walkRequests++ },
    overlayHasTransfer: () => w.active,
    claimedPathFor,
    listDownloadClaimsForShare: async () => { reads.claims++; return world ? new Map([[drivePath, world.rec]]) : new Map() },
    listVerifiedRecordsForShare: async () => { reads.verified++; return rec ? new Map([['f.txt', rec]]) : new Map() },
    verdictForClaim: (spaceId, filePath, claim, currentHash) => (claim
      ? { ...claimVerdict({ rec: claim, currentHash, exists: world.exists, dirExists: world.dirExists, pinned: world.pinned, insidePinned: world.insidePinned }), stat: statOrNull(claimedPathFor(filePath, claim)) }
      : claimVerdict({ rec: null })),
    pruneDownloadClaims: async (spaceId, drivePaths) => { pruned.push(...drivePaths); return drivePaths.length },
  }
}

function matrix() {
  const cells = []
  for (const mirrored of [true, false]) {
    for (const sizeMatch of mirrored ? [true, false] : [false]) {
      for (const renamed of mirrored ? [true, false] : [false]) {
        for (const fetchActive of mirrored ? [true, false] : [false]) {
          for (const claim of mirrored ? ['none'] : Object.keys(CLAIMS)) {
            for (const verified of VERIFIED) {
              for (const hashed of [true, false]) {
                for (const ownerOnline of [true, false]) {
                  for (const pending of mirrored ? ['none'] : Object.keys(PENDING)) {
                    for (const active of mirrored ? [false] : [true, false]) {
                      cells.push({ mirrored, sizeMatch, renamed, fetchActive, claim, verified, hashed, ownerOnline, pending, active })
                    }
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

test('every row of the decision space matches the rule, at two scans and no reads per row', async (t) => {
  const root = tmpDir('mirall-listing-parity')
  const present = path.join(root, 'present')
  const empty = path.join(root, 'empty')
  fs.mkdirSync(present, { recursive: true })
  fs.mkdirSync(empty, { recursive: true })
  fs.writeFileSync(path.join(present, 'f.txt'), '0123456789')
  // Same size as the natural name, or a renamed cell could never be a size match and the new
  // dimension would prove nothing.
  fs.writeFileSync(path.join(present, RENAMED_LEAF), '0123456789')
  const landed = path.join(root, 'landed.txt')
  fs.writeFileSync(landed, '0123456789')
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })

  // A record's fingerprint is taken from the file it describes; a local path that is not on disk
  // fingerprints as nothing, which no stat can ever match.
  const fingerprintOf = (local) => {
    const abs = local === null ? null : path.isAbsolute(local) ? local : path.join(present, local)
    const stat = abs && statOrNull(abs)
    return stat ? { mtime: Math.floor(stat.mtimeMs), ino: Number(stat.ino) || 0 } : { mtime: -1, ino: 0 }
  }

  const cells = matrix()
  t.ok(cells.length > 500, `${cells.length} combinations covered`)
  let mismatches = 0
  let prunesChecked = 0
  const seen = new Set()
  for (const w of cells) {
    const mountPath = w.sizeMatch ? present : empty
    const rec = recordFor(w, fingerprintOf, landed)
    const expected = baselineRow(w, mountPath, rec, landed)
    const deps = worldDeps(w, mountPath, rec, landed)
    const res = await listOverlayShareFiles(SPACE, SHARE, backendFor([entryOf(w)]), deps)
    const gotRow = res.entries[0]
    const wantRow = shaped(w, expected.row)
    seen.add(wantRow.status + (wantRow.verified ? '+verified' : ''))
    if (expected.walk) seen.add('walk:' + wantRow.status)
    if (!w.mirrored && w.verified === 'edited') seen.add('download-edited:' + wantRow.status)
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
    // The fingerprint is judged from the prefetched record and the row's own stat: still one scan
    // per namespace, and a mirror listing asks for a walk exactly when it shows an edited copy.
    if (deps.reads.verified !== 1 || deps.reads.claims !== (w.mirrored ? 0 : 1)) {
      mismatches++
      t.fail('scan count: ' + describe(w) + ' ' + JSON.stringify(deps.reads))
    }
    if (deps.reads.walkRequests !== (expected.walk ? 1 : 0)) {
      mismatches++
      t.fail('walk request: ' + describe(w) + ' ' + JSON.stringify(deps.reads))
    }
  }
  t.is(mismatches, 0, 'every combination renders the same row, prunes the same claims and reads the same scans')
  t.ok(prunesChecked > 0, 'the matrix actually exercises the pruning branches')
  // A moved inode on a mirror stays synced and asks for the walk; a download edited in place, which
  // nothing re-hashes, drifts to downloaded rather than reading as an edit.
  for (const outcome of ['synced+verified', 'synced', 'downloaded+verified', 'downloaded', 'modified', 'walk:modified', 'walk:synced', 'download-edited:downloaded']) {
    t.ok(seen.has(outcome), `the matrix reaches ${outcome}`)
  }
})

function mirrorDir(t, label, files) {
  const root = tmpDir('mirall-' + label)
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(root, name), body)
  t.teardown(() => { try { fs.rmSync(root, { recursive: true, force: true }) } catch {} })
  return root
}

// REGRESSION (FIX-MIRROR-RENAME: the mirror places a colliding entry at a sibling name and records
// it in mount.renamedPaths, but the listing derived the local path from the owner key alone. It
// therefore stat'd a path the mirror never wrote, and a fully-mirrored file rendered as 'remote' —
// with a download button — for as long as the collision stood.)
test("REGRESSION (FIX-MIRROR-RENAME): a collision-renamed mirror row is 'synced'", async (t) => {
  const root = mirrorDir(t, 'renamed', {
    'f.txt': 'THE USERS OWN FILE, a different length',
    'f (1).txt': '0123456789',
  })
  const deps = countingDeps()
  deps.getForeignMount = async () => ({ enabled: true, mountPath: root, renamedPaths: { 'f.txt': 'f (1).txt' } })

  const entry = { relPath: 'f.txt', size: 10, contentHash: 'h1', mtime: 0 }
  const res = await listOverlayShareFiles(SPACE, SHARE, backendFor([entry]), deps)

  t.is(res.entries[0].status, 'synced', 'not remote — the bytes are on disk under the sibling name')
  t.is(res.entries[0].localPath, path.join(root, 'f (1).txt'), 'and the row points at them')
})

test('an unrenamed mirror row is unaffected by the mapping lookup', async (t) => {
  const root = mirrorDir(t, 'unrenamed', { 'f.txt': '0123456789' })
  const deps = countingDeps()
  // A mapping that exists but does not cover this entry — the fallback to the owner key.
  deps.getForeignMount = async () => ({ enabled: true, mountPath: root, renamedPaths: { 'other.txt': 'other (1).txt' } })

  const res = await listOverlayShareFiles(SPACE, SHARE, backendFor([{ relPath: 'f.txt', size: 10, contentHash: 'h1', mtime: 0 }]), deps)
  t.is(res.entries[0].status, 'synced')
  t.is(res.entries[0].localPath, path.join(root, 'f.txt'))
})

// REGRESSION (FIX-MIRROR-OFFLINE): the mirror kept a fetch "in flight" against an offline owner —
// parked on the overlay's peer wait, transferring nothing — and this row reported it 'downloading'.
// The renderer paints a downloading row with no bytes as "Preparing…", so the folder showed a badge
// walking from file to file directly beneath its own "the owner is offline" banner. The strip and
// the folder tile already suppressed their equivalents; the row was the surface that did not.
test("REGRESSION (FIX-MIRROR-OFFLINE): a parked mirror fetch is not 'downloading' when the owner is away", async (t) => {
  const root = mirrorDir(t, 'offline-parked', {})
  const deps = countingDeps()
  deps.getForeignMount = async () => ({ enabled: true, mountPath: root })
  deps.foreignFetchActive = () => true

  deps.isOwnerOnline = () => false
  const away = await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(1)), deps)
  t.is(away.entries[0].status, 'unavailable', 'offline: the parked fetch does not read as a download')

  deps.isOwnerOnline = () => true
  const back = await listOverlayShareFiles(SPACE, SHARE, backendFor(rows(1)), deps)
  t.is(back.entries[0].status, 'downloading', 'online: a real in-flight fetch still reads as one')
})
