import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import Hyperbee from 'hyperbee'
import { setupSelfMirror } from '../helpers/owned.js'
import { waitFor } from '../helpers/bare-poll.js'
import { getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/overlay/index.js'
import { acquireFetchSlot, fetchClaimedBy, fetchSlotStats } from '../../src/shared/transfer/overlay/fetch-gate.js'
import { materializeCatalogFile, runMaterializeTick, setMirrorReachability } from '../../src/shared/folders/mirror-pass.js'
import { requestMirrorWalk, setForeignEnabled, stopForeignLoop, unmountForeignFolder } from '../../src/shared/folders/foreign-verbs.js'
import { getForeignMount } from '../../src/shared/folders/mount-store.js'
import { getRuntimeConfig, setRuntimeConfig } from '../../src/shared/core/runtime-config.js'
import { STATUS_MOUNT_GONE, isAutoPauseStatus } from '../../src/shared/contract/mount-fault.js'
import { CODES } from '../../src/shared/contract/errors.js'
import { shareDecoKey } from '../../src/shared/contract/decoration-key.js'
import { FREE_SPACE_HEADROOM } from '../../src/shared/transfer/free-space.js'
import { PARTIAL_SUFFIX } from '../../src/shared/transfer/partial-suffix.js'
import { transferIdFor } from '../../src/shared/transfer/transfer-id.js'
import { overlayHashFile } from '../../src/shared/transfer/overlay/overlay-hash.js'
import { runPublishPass } from '../../src/shared/folders/owned-pass.js'
import { listOverlayShareFiles } from '../../src/shared/shares/share-listing.js'
import { presence } from '../../src/shared/network/presence-leases.js'

// What a mirror does between "this entry should be on disk" and "it is". Every case enters through
// runMaterializeTick or materializeCatalogFile (with its `probe`, `synced` and `hashOf` options) and
// reads that function's outcome words; what it asserts is the vendor's fetchFile, the stored mount
// record, the fetch gate and claim registry, the disk and the frames the renderer receives. Nothing
// is imported from the module that does the fetch, so the cases hold for any code behind those two
// entry points.

// The fetch gate, the claim registry, the runtime config and the reachability verdict are reset by
// each case's own boot and root close, so a case sets only what it changes.
async function mirror(t, files, { concurrency = null } = {}) {
  const ctx = await setupSelfMirror(t, { files })
  if (concurrency !== null) setRuntimeConfig({ ...getRuntimeConfig(), downloadConcurrency: concurrency })
  const { entries } = await overlayBackend.listPeerWithMeta(ctx.spaceId, ctx.share)
  return { ctx, byPath: Object.fromEntries(entries.map((e) => [e.relPath, e])) }
}

// Records every call that reaches the vendor. `inner` decides what the call does and may be swapped
// mid-case; `real` is the self-mirror's working copy stub.
function vendor(t) {
  const overlay = getOverlay()
  const prev = overlay.fetchFile
  const real = (hash, opts) => prev.call(overlay, hash, opts)
  const v = { calls: 0, hashes: [], opts: [], real, inner: real }
  overlay.fetchFile = async (hash, opts) => {
    v.calls++
    v.hashes.push(hash)
    v.opts.push(opts)
    return await v.inner(hash, opts)
  }
  // Ahead of the fixture's own restore, which equal-order teardowns would run first.
  t.teardown(() => { overlay.fetchFile = prev }, { order: -1 })
  return v
}

// A volume reading for the free-space preflight, through the production `probe` parameter: a full
// volume cannot be made on a CI runner.
const probe = (freeBytes) => ({ rootAvailable: () => true, freeBytes: () => freeBytes })

const stored = (ctx) => getForeignMount(ctx.spaceId, ctx.share.id)
// A missing file reads as null, so a regression fails its assertion instead of throwing out of it.
const read = (file) => { try { return fs.readFileSync(file, 'utf8') } catch { return null } }
const hashMismatch = () => Object.assign(new Error('hash mismatch'), { code: 'EHASHMISMATCH' })

// A well-formed scheduler-end frame: a holder was asked and the transfer died, which is a per-file
// miss rather than the zero-peer answer that ends a pass.
const SCHEDULER_END = {
  reason: 'timeout', receivedBytes: 0, totalBytes: 1, totalChunks: 1, chunksRemaining: 1, peers: 1, elapsedMs: 10,
}

// -- Preflight: a destination that cannot take the file is settled before any holder is asked.

test('a mirror root removed before the pass pauses the mount as gone and is never recreated', async (t) => {
  const { ctx } = await mirror(t, { 'a.txt': 'alpha', 'sub/b.txt': 'bravo' })
  const v = vendor(t)
  // A holder that died is a per-file miss, so a pass that got past the preflight would walk on to
  // the nested entry, whose folder it would have to create.
  v.inner = async (hash, opts) => { opts.onEnd?.(SCHEDULER_END); return null }
  fs.rmSync(ctx.mirrorPath, { recursive: true })

  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  t.is(v.calls, 0, 'no holder was asked for a file with nowhere to land')
  t.absent(fs.existsSync(ctx.mirrorPath), 'the folder the user deleted stays deleted')
  const mount = await stored(ctx)
  t.is(mount.enabled, false, 'the mount is paused')
  t.is(mount.status, STATUS_MOUNT_GONE, 'as a folder that is gone')
})

test('an exhausted volume pauses the mount with the disk-full code and asks no holder', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': 'alpha' })
  const v = vendor(t)

  t.is(await materializeCatalogFile(ctx.mount, ctx.share, byPath['a.txt'], { probe: probe(0) }), 'blocked')

  t.is(v.calls, 0, 'no holder was asked')
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'a.txt')), 'nothing landed')
  const mount = await stored(ctx)
  t.is(mount.enabled, false, 'the volume is out, so the whole mount pauses')
  t.is(mount.status, 'paused-enospc')
  t.is(mount.lastError, CODES.TRANSFER_DISK_FULL, 'with the code the folder screen names the fault by')
  t.ok(ctx.fake.events.some((e) => e.type === 'event:foreign-folder-mount-status' &&
    e.payload?.shareId === ctx.share.id && e.payload.status === 'paused-enospc'), 'and the renderer is told')
})

test('a file the volume cannot hold is skipped while the mount and the rest of the folder carry on', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'big.txt': '12345678', 'a.txt': 'x' })
  const v = vendor(t)
  // Two bytes free past the headroom: the one-byte file fits, the eight-byte file does not.
  const p = probe(FREE_SPACE_HEADROOM + 2)

  t.is(await materializeCatalogFile(ctx.mount, ctx.share, byPath['big.txt'], { probe: p }), 'blocked')
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, byPath['a.txt'], { probe: p }), 'present')

  t.alike(v.hashes, [byPath['a.txt'].contentHash], 'only the file that fits reached a holder')
  t.is(read(path.join(ctx.mirrorPath, 'a.txt')), 'x', 'and it landed')
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'big.txt')), 'the one that does not fit did not')
  const mount = await stored(ctx)
  t.is(mount.enabled, true, 'one oversized file does not pause the mount')
  t.absent(isAutoPauseStatus(mount.status), `nor record a mount fault (status ${mount.status})`)
})

test('the bytes a resumed partial already holds count toward the room it needs', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'big.txt': '12345678' })
  const v = vendor(t)
  const partial = path.join(ctx.mirrorPath, 'big.txt') + PARTIAL_SUFFIX
  fs.writeFileSync(partial, Buffer.alloc(64 * 1024, 1))
  const allocated = fs.statSync(partial).blocks * 512
  t.ok(allocated >= 8, `precondition: the partial holds allocated blocks (${allocated} bytes)`)

  const outcome = await materializeCatalogFile(ctx.mount, ctx.share, byPath['big.txt'], { probe: probe(FREE_SPACE_HEADROOM + 2) })

  t.is(v.calls, 1, 'the file was fetched although it needs more than the room past the headroom')
  t.is(outcome, 'present')
  t.is(read(path.join(ctx.mirrorPath, 'big.txt')), '12345678', 'and it landed')
})

// -- A pass parked on the shared fetch gate: what may change while it waits for a slot.

test('a stop that lands while a pass is parked fetches nothing and leaves the user\'s edit in place', async (t) => {
  const { ctx } = await mirror(t, { 'a.txt': 'owner' }, { concurrency: 1 })
  const { spaceId } = ctx
  const shareId = ctx.share.id
  await runMaterializeTick(spaceId, shareId)
  const landed = path.join(ctx.mirrorPath, 'a.txt')
  t.is(read(landed), 'owner', 'precondition: the mirror delivered the owner\'s file')

  // The user edits the delivered file, and the watcher asks for a walk; the pass that walks it would
  // move the edit aside and restore the owner's version.
  fs.writeFileSync(landed, 'user edit')
  requestMirrorWalk(spaceId, shareId)
  const v = vendor(t)
  const hog = await acquireFetchSlot({})
  const pass = runMaterializeTick(spaceId, shareId)
  await waitFor(() => fetchSlotStats().queued === 1, 5000, { interval: 10, label: 'the pass to park on the gate' })

  stopForeignLoop(spaceId, shareId)
  hog()
  await pass

  t.is(v.calls, 0, 'no holder was asked once the stop landed')
  t.is(read(landed), 'user edit', 'the edit is where the user left it')
  t.alike(fs.readdirSync(ctx.mirrorPath), ['a.txt'], 'and was not moved aside into a conflict copy')
  t.is(fetchSlotStats().held, 0, 'the slot was released')
  t.is(fetchClaimedBy(transferIdFor(spaceId, shareId, 'a.txt')), null, 'and no claim was left behind')
})

test('an owner who leaves while a pass is parked costs that pass one fetch, then ends it', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': '1', 'b.txt': '2', 'c.txt': '3' }, { concurrency: 1 })
  const { spaceId } = ctx
  const shareId = ctx.share.id
  const v = vendor(t)
  const hog = await acquireFetchSlot({})
  const pass = runMaterializeTick(spaceId, shareId)
  await waitFor(() => fetchSlotStats().queued === 1, 5000, { interval: 10, label: 'the pass to park on the gate' })

  // Gone while parked: the next reachability verdict says so, and the engine answers a fetch with
  // no peers by resolving null without ever ending a scheduler.
  setMirrorReachability(() => false)
  v.inner = async () => null
  hog()
  await pass

  t.alike(v.hashes, [byPath['a.txt'].contentHash], 'the parked entry asked once; the rest of the walk was never asked')
  const mount = await stored(ctx)
  t.is(mount.enabled, true, 'an owner leaving is not a local fault')
  t.absent(isAutoPauseStatus(mount.status), `nor recorded as one (status ${mount.status})`)

  // Ending the pass early strands nothing: the owner's return fetches the whole folder.
  setMirrorReachability(null)
  v.inner = v.real
  await runMaterializeTick(spaceId, shareId)
  t.is(v.calls, 4, 'the next pass fetched all three files')
})

test('a pass that found no holder withholds the owner\'s deletions', async (t) => {
  const { ctx } = await mirror(t, { 'a.txt': 'alpha', 'b.txt': 'bravo' })
  const { spaceId } = ctx
  const shareId = ctx.share.id
  await runMaterializeTick(spaceId, shareId)
  const kept = path.join(ctx.mirrorPath, 'b.txt')
  t.is(read(kept), 'bravo', 'precondition: the mirror delivered and owns b.txt')

  // The owner deletes b.txt; the mirror has lost a.txt, so the next pass has a fetch to make.
  fs.unlinkSync(path.join(ctx.mountPath, 'b.txt'))
  await runPublishPass(spaceId, shareId, ctx.mountPath, [])
  fs.unlinkSync(path.join(ctx.mirrorPath, 'a.txt'))
  requestMirrorWalk(spaceId, shareId)
  const v = vendor(t)
  v.inner = async () => null

  await runMaterializeTick(spaceId, shareId)

  t.is(v.calls, 1, 'the pass asked for a.txt and stopped at the zero-peer answer')
  t.is(read(kept), 'bravo', 'a pass that walked only a prefix does not act on the owner\'s deletions')
})

// -- The fetch contract: what the vendor is told, and what every settle leaves behind.

test('the vendor is told the owner, the catalog size and where the file lands', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': 'alpha' })
  const v = vendor(t)
  const entry = byPath['a.txt']

  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entry), 'present')

  t.is(v.calls, 1)
  const [opts] = v.opts
  t.is(opts.ownerKey, ctx.mount.ownerKey, 'the owner, so the engine can find a holder for this share')
  t.is(opts.size, entry.size, 'the catalog size, so progress has a total before the first chunk')
  t.is(opts.destPath, path.join(ctx.mirrorPath, 'a.txt'), 'the file lands at its mirror path')
})

test('a landing gives the file a fresh checksum budget', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': 'alpha' })
  const entry = byPath['a.txt']
  const v = vendor(t)
  v.inner = async (hash, opts) => (v.calls === 3 ? await v.real(hash, opts) : Promise.reject(hashMismatch()))
  const once = () => materializeCatalogFile(ctx.mount, ctx.share, entry)

  t.is(await once(), 'missing')
  t.is(await once(), 'missing')
  t.is(await once(), 'present', 'the third attempt lands')
  fs.rmSync(path.join(ctx.mirrorPath, 'a.txt'))
  for (let i = 0; i < 5; i++) await once()

  // Two failures, one landing, then a whole budget of three again before the mirror stops asking.
  t.is(v.calls, 6, 'the failures before the landing were not carried past it')
})

test('every way a fetch ends clears its row\'s transfer decoration', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'd.txt': 'done', 'n.txt': 'none', 'e.txt': 'error', 'c.txt': 'cancel' })
  const byHash = Object.fromEntries(Object.values(byPath).map((e) => [e.contentHash, e.relPath]))
  const v = vendor(t)
  const settle = {
    'd.txt': (hash, opts) => v.real(hash, opts),
    'n.txt': async (hash, opts) => { opts.onEnd?.(SCHEDULER_END); return null },
    'e.txt': async () => { throw new Error('boom') },
    'c.txt': async () => { throw Object.assign(new Error('cancelled'), { code: 'ECANCELLED' }) },
  }
  v.inner = (hash, opts) => settle[byHash[hash]](hash, opts)

  for (const rel of Object.keys(settle)) {
    // Counted from here: on a self-mirror the owner's publish pass reports under the same key.
    const from = ctx.fake.events.length
    await materializeCatalogFile(ctx.mount, ctx.share, byPath[rel])
    const key = shareDecoKey(ctx.share.id, rel)
    const frames = ctx.fake.events.slice(from).filter((e) => e.type === 'event:decoration' && e.payload?.key === key)
    t.is(frames.filter((f) => f.payload.done === true).length, 1, `${rel}: exactly one terminal frame`)
    t.is(frames.at(-1)?.payload.done, true, `${rel}: and it is the last word on the row`)
  }
  t.is(v.calls, 4, 'every entry reached the vendor')
})

// REGRESSION (FIX-662: the mirror's verify frame said 0 bytes whatever the partial held, so the bar of
// a resumed file dropped to nothing while it was verified.) The engine reports the intact bytes it
// has recovered with each fraction (overlay-engine-transfer.test.js pins that half); this pins that
// the mirror's frame carries them.
test('REGRESSION (FIX-662): the mirror\'s verify frame carries the bytes the verify has recovered', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': 'alpha' })
  const v = vendor(t)
  const reports = [[0, 0], [0.5, 3], [1, 5]]
  v.inner = async (hash, opts) => {
    for (const [fraction, bytes] of reports) opts.onVerify?.(fraction, bytes)
    return await v.real(hash, opts)
  }
  const from = ctx.fake.events.length

  t.is(await materializeCatalogFile(ctx.mount, ctx.share, byPath['a.txt']), 'present')

  const key = shareDecoKey(ctx.share.id, 'a.txt')
  const verifying = ctx.fake.events.slice(from)
    .filter((e) => e.type === 'event:decoration' && e.payload?.key === key && e.payload.phase === 'verifying')
  t.alike(verifying.map((f) => [f.payload.verifyFraction, f.payload.bytes]), reports, 'each frame carries its report\'s bytes')
  t.ok(verifying.every((f) => f.payload.total === byPath['a.txt'].size), 'against the catalog size')
})

test('a local hit is copied to the mirror path and recorded as verified', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': 'alpha' })
  const entry = byPath['a.txt']
  const spooled = path.join(ctx.tmpDir('spool'), 'blob')
  fs.writeFileSync(spooled, 'alpha')
  const v = vendor(t)
  // The engine answers a hash it already holds with the path it holds it at, and writes nothing.
  v.inner = async () => ({ destPath: spooled, local: true, size: entry.size })

  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entry), 'present')
  const landed = path.join(ctx.mirrorPath, 'a.txt')
  t.ok(fs.existsSync(landed), 'the bytes are at the mirror path')
  t.is(read(landed), 'alpha', 'and they are the owner\'s')

  // A pass that owns the path, so only the verified record can spare it a hash of the file.
  v.inner = v.real
  let hashes = 0
  const hashOf = async (file) => { hashes++; return await overlayHashFile(file) }
  t.is(await materializeCatalogFile(ctx.mount, ctx.share, entry, { synced: new Set(['a.txt']), hashOf }), 'present')
  t.is(hashes, 0, 'the copy was recorded, so the next pass trusts it without re-reading it')
  t.is(v.calls, 1, 'and asks no one')
})

// A local hit whose copy into the mount throws `code`: the engine answers with the path it holds the
// bytes at, and the copy from there fails as a full or broken disk would.
function failingLocalHit(t, ctx, v, entry, code) {
  const spooled = path.join(ctx.tmpDir('spool'), 'blob')
  fs.writeFileSync(spooled, 'alpha')
  v.inner = async () => ({ destPath: spooled, local: true, size: entry.size })
  const copy = fs.copyFileSync
  fs.copyFileSync = (from, to, ...rest) => {
    if (from === spooled) throw Object.assign(new Error('copy failed'), { code })
    return copy.call(fs, from, to, ...rest)
  }
  t.teardown(() => { fs.copyFileSync = copy })
}

// REGRESSION (FIX-659: a local hit whose copy into the mount failed was reported missing at debug
// level, so a full disk neither paused the mount nor charged the file, and every tick asked again.)
test('REGRESSION (FIX-659): a local hit that cannot be copied for a full disk pauses the mount', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': 'alpha' })
  const v = vendor(t)
  failingLocalHit(t, ctx, v, byPath['a.txt'], 'ENOSPC')

  t.is(await materializeCatalogFile(ctx.mount, ctx.share, byPath['a.txt']), 'missing')
  await runMaterializeTick(ctx.spaceId, ctx.share.id)

  const mount = await stored(ctx)
  t.is(mount.enabled, false, 'the mount is paused')
  t.is(mount.status, 'paused-enospc', 'with the full-disk status')
  t.is(mount.lastError, CODES.TRANSFER_DISK_FULL)
  t.is(v.calls, 1, 'and the paused mount asks no one again')
  t.absent(fs.existsSync(path.join(ctx.mirrorPath, 'a.txt')), 'nothing landed')
})

test('REGRESSION (FIX-659): a local hit that keeps failing its copy stops after the attempt budget', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': 'alpha' })
  const v = vendor(t)
  failingLocalHit(t, ctx, v, byPath['a.txt'], 'EIO')
  const outcomes = []
  for (let i = 0; i < 5; i++) outcomes.push(await materializeCatalogFile(ctx.mount, ctx.share, byPath['a.txt']))

  t.is(v.calls, 3, 'each failed copy was charged, so the mirror stopped asking after its budget')
  t.alike(outcomes, ['missing', 'missing', 'missing', 'blocked', 'blocked'])
  t.is((await stored(ctx)).enabled, true, 'a fault this does not classify pauses nothing')
})

// -- The stop path: what a pause asks the vendor to cancel.

// The vendor's cancel, as the engine models it: a cancel reaches only the fetch of the caller it
// names (`by`). One for that caller's fetch in flight rejects it ECANCELLED; one with no fetch of
// that caller in flight is remembered and consumed by the same caller's next fetch of the hash,
// which then rejects ECANCELLED (fetch-session.js). Every call is recorded. It wraps the counting
// `vendor`, whose fetch then runs `through` unless a cancel was waiting for it.
function vendorCancel(t, v, through) {
  const overlay = getOverlay()
  const prev = overlay.cancelFetch
  const c = { calls: [], live: new Map(), pending: new Set() }
  const cancelled = () => Object.assign(new Error('cancelled'), { code: 'ECANCELLED' })
  const callerKey = (hash, opts) => hash + '|' + (opts?.by ?? null)
  overlay.cancelFetch = (hash, opts) => {
    c.calls.push({ hash, opts })
    const key = callerKey(hash, opts)
    const live = c.live.get(key)
    if (live) live(cancelled())
    else c.pending.add(key)
    return true
  }
  v.inner = async (hash, opts) => {
    const key = callerKey(hash, opts)
    if (c.pending.delete(key)) throw cancelled()
    const stop = new Promise((_resolve, reject) => c.live.set(key, reject))
    try { return await Promise.race([through(hash, opts), stop]) } finally { c.live.delete(key) }
  }
  t.teardown(() => { overlay.cancelFetch = prev }, { order: -1 })
  return c
}

// REGRESSION (FIX-661: a fetch that rejected with a local I/O fault paused the mount while its
// in-flight record was still set, so the pause's stop path asked the vendor to cancel a fetch that
// had already settled. The vendor kept that as a cancel for the mirror's next fetch of the hash,
// and the first retry after the resume was cancelled.)
test('REGRESSION (FIX-661): a fetch that pauses the mount on a disk fault leaves no cancel for the retry', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'a.txt': 'alpha' })
  const { spaceId } = ctx
  const shareId = ctx.share.id
  const hash = byPath['a.txt'].contentHash
  const v = vendor(t)
  const c = vendorCancel(t, v, async (h, opts) => (v.calls === 1
    ? Promise.reject(Object.assign(new Error('no space left on device'), { code: 'ENOSPC' }))
    : await v.real(h, opts)))

  await runMaterializeTick(spaceId, shareId)
  t.is((await stored(ctx)).status, 'paused-enospc', 'precondition: the first fetch paused the mount')
  t.alike(c.calls.map((call) => call.hash), [], 'the pause asked the vendor to cancel nothing')

  await setForeignEnabled(spaceId, shareId, true)
  await runMaterializeTick(spaceId, shareId)

  t.is(v.calls, 2, 'the resume retried the file once')
  t.is(read(path.join(ctx.mirrorPath, 'a.txt')), 'alpha', 'and the retry landed instead of being cancelled')
  t.ok(c.pending.size === 0 && !c.calls.some((call) => call.hash === hash), 'no cancel is left waiting for that hash')
})

// A promise the test resolves, and whether anything is waiting on it yet.
function hold() {
  const h = { waiting: false, release: () => {} }
  h.promise = new Promise((resolve) => { h.release = resolve })
  return h
}

// Holds the read of a.txt's verified record that the pass makes holding its fetch slot: the
// local-edit check's ancestor read, the one await between the slot and the move-aside. The read the
// pass makes before queueing for the slot passes through.
function holdAncestorRead(t, h) {
  const get = Hyperbee.prototype.get
  Hyperbee.prototype.get = async function (key, ...rest) {
    if (typeof key === 'string' && key.startsWith('verified:') && key.endsWith('a.txt') && fetchSlotStats().held === 1) {
      h.waiting = true
      await h.promise
    }
    return await get.call(this, key, ...rest)
  }
  t.teardown(() => { Hyperbee.prototype.get = get })
}

// A self-mirror lists as its owner; under another owner key, online, it takes the consumer branch
// that reads whether the mirror is fetching the row.
async function mirrorRowStatus(t, ctx, relPath) {
  const peer = 'f'.repeat(64)
  presence.mark(peer, ctx.spaceId)
  t.teardown(() => presence.clear(peer))
  const res = await listOverlayShareFiles(ctx.spaceId, { ...ctx.share, owner: peer }, overlayBackend)
  return res.entries.find((e) => e.relPath === relPath)?.status
}

// A mirror whose user has edited the delivered a.txt, with a walk requested so the next pass moves
// the edit aside before fetching the owner's version.
async function editedMirror(t) {
  const { ctx } = await mirror(t, { 'a.txt': 'owner' })
  await runMaterializeTick(ctx.spaceId, ctx.share.id)
  const landed = path.join(ctx.mirrorPath, 'a.txt')
  t.is(read(landed), 'owner', 'precondition: the mirror delivered the owner\'s file')
  fs.writeFileSync(landed, 'user edit')
  requestMirrorWalk(ctx.spaceId, ctx.share.id)
  return { ctx, landed }
}

// REGRESSION (FIX-666: the in-flight record a stop cancels by was written only after the awaits past
// the slot re-check, so a stop landing while the pass made a folder or moved a local edit aside
// found nothing to cancel, and the pass then asked a holder for the file under a stopped mount.)
test('REGRESSION (FIX-666): a stop that lands before a local edit is moved aside asks no holder and keeps the edit', async (t) => {
  const { ctx, landed } = await editedMirror(t)
  const { spaceId } = ctx
  const shareId = ctx.share.id
  const v = vendor(t)
  const c = vendorCancel(t, v, v.real)
  const h = hold()
  holdAncestorRead(t, h)
  const pass = runMaterializeTick(spaceId, shareId)
  await waitFor(() => h.waiting, 5000, { interval: 10, label: 'the pass to read the edit\'s ancestor' })

  stopForeignLoop(spaceId, shareId)
  h.release()
  await pass

  t.is(v.calls, 0, 'no holder was asked once the stop landed')
  t.alike(c.calls, [], 'and the vendor holds no cancel for a fetch it was never asked for')
  t.is(read(landed), 'user edit', 'the edit is where the user left it')
  t.alike(fs.readdirSync(ctx.mirrorPath), ['a.txt'], 'and was not moved aside into a conflict copy')
  t.is(fetchClaimedBy(transferIdFor(spaceId, shareId, 'a.txt')), null, 'no claim was left behind')
  t.is(fetchSlotStats().held, 0, 'and the slot was released')
})

// A stop that lands once the move is under way cannot undo it: the edit is kept as the conflict
// copy, and the owner's version lands at the natural name on the pass after the resume.
test('a stop that lands while a local edit is being moved aside lets the move finish and asks no holder', async (t) => {
  const { ctx, landed } = await editedMirror(t)
  const { spaceId } = ctx
  const shareId = ctx.share.id
  const v = vendor(t)
  const h = hold()
  const rename = fs.promises.rename
  fs.promises.rename = async (from, to) => {
    if (from === landed) { h.waiting = true; await h.promise }
    return await rename.call(fs.promises, from, to)
  }
  t.teardown(() => { fs.promises.rename = rename })
  const pass = runMaterializeTick(spaceId, shareId)
  await waitFor(() => h.waiting, 5000, { interval: 10, label: 'the pass to move the edit aside' })

  stopForeignLoop(spaceId, shareId)
  h.release()
  await pass

  t.is(v.calls, 0, 'no holder was asked once the stop landed')
  const names = fs.readdirSync(ctx.mirrorPath)
  t.absent(names.includes('a.txt'), 'the natural name waits for the next pass')
  t.is(names.length, 1, 'and the edit is the one file left')
  t.is(read(path.join(ctx.mirrorPath, names[0])), 'user edit', 'kept as the conflict copy')
})

// An unmount before the vendor is asked tells the holder a paused fetch left showing us paused that
// we stopped, and asks the vendor to cancel nothing.
test('an unmount that lands before the vendor call cancels nothing and tells the paused holder we stopped', async (t) => {
  const { ctx, byPath } = await mirror(t, { 'sub/a.txt': 'alpha' })
  const { spaceId } = ctx
  const shareId = ctx.share.id
  const hash = byPath['sub/a.txt'].contentHash
  const overlay = getOverlay()
  const notified = []
  const notify = overlay.notifyTransferStopped
  overlay.notifyTransferStopped = (h) => { notified.push(h); return true }
  t.teardown(() => { overlay.notifyTransferStopped = notify })
  const v = vendor(t)
  const c = vendorCancel(t, v, () => new Promise(() => {}))

  // A fetch the holder is serving, paused: the holder is left showing us paused.
  const first = runMaterializeTick(spaceId, shareId)
  await waitFor(() => v.calls === 1, 5000, { interval: 10, label: 'the first fetch to reach the vendor' })
  await setForeignEnabled(spaceId, shareId, false)
  await first
  t.is(c.calls.length, 1, 'precondition: the pause cancelled the fetch the vendor was running')

  // The resume's pass is held making the file's folder, before it asks the vendor.
  const h = hold()
  const sub = path.join(ctx.mirrorPath, 'sub')
  const mkdir = fs.promises.mkdir
  fs.promises.mkdir = async (dir, ...rest) => {
    if (dir === sub) { h.waiting = true; await h.promise }
    return await mkdir.call(fs.promises, dir, ...rest)
  }
  t.teardown(() => { fs.promises.mkdir = mkdir })
  await setForeignEnabled(spaceId, shareId, true)
  await waitFor(() => h.waiting, 5000, { interval: 10, label: 'the resumed pass to make the folder' })
  const row = await mirrorRowStatus(t, ctx, 'sub/a.txt')
  t.ok(row, 'precondition: the row is listed')
  t.not(row, 'downloading', `a fetch no holder was asked for is not listed as downloading (${row})`)

  const gone = unmountForeignFolder(spaceId, shareId)
  h.release()
  await gone
  await waitFor(() => fetchSlotStats().held === 0, 5000, { interval: 10, label: 'the resumed pass to end' })

  t.is(v.calls, 1, 'the resumed pass asked no holder')
  t.is(c.calls.length, 1, 'and the unmount asked the vendor to cancel nothing')
  t.alike(notified, [hash], 'the holder the pause left showing us paused is told we stopped')
})
