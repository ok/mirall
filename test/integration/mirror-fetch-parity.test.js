import test from 'brittle'
import fs from 'bare-fs'
import path from 'bare-path'
import { setupSelfMirror } from '../helpers/owned.js'
import { waitFor } from '../helpers/bare-poll.js'
import { getOverlay } from '../../src/shared/transfer/overlay/overlay-instance.js'
import { overlayBackend } from '../../src/shared/transfer/overlay/index.js'
import { acquireFetchSlot, fetchClaimedBy, fetchSlotStats } from '../../src/shared/transfer/overlay/fetch-gate.js'
import { materializeCatalogFile, runMaterializeTick, setMirrorReachability } from '../../src/shared/folders/mirror-pass.js'
import { requestMirrorWalk, stopForeignLoop } from '../../src/shared/folders/foreign-verbs.js'
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
