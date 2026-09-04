// Leftover-core reclamation: build the deterministic set of every core current state
// still needs (the "wanted" set), classify each store core outside it by content
// sniffing, and purge only the provably-safe categories. Conservative by design —
// anything unidentified stays on disk.
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hyperbee from 'hyperbee'
import Hyperdrive from 'hyperdrive'
import { createLogger } from '../core/logger.js'
import { getStore, createBee, createLocalBee, LOCAL_BEE_NAMES } from '../core/store.js'
import { listSpaces, getDrive, purgeCoreDk } from '../spaces/space.js'
import { getProfileBee, withPeerBee } from '../spaces/profile.js'
import { ownCatalog, readCatalogKey } from '../shares/share-catalog.js'
import { compactStore } from '../transfer/swarm.js'
import { withReadTimeout } from '../core/with-timeout.js'
import { mapLimit } from '../core/concurrency.js'
import { classifyBeeKind } from './leftover-classify.js'
import { decideSweep } from './sweep-decision.js'
import { recordSweep } from './sweep-journal.js'
import { getResourceCaps } from '../core/runtime-config.js'
import { listContentKeys } from '../spaces/space-keys.js'

const log = createLogger('leftover')

// profile stays plaintext (replicated); LOCAL_BEE_NAMES are the at-rest-encrypted
// '/v2' cores, opened via createLocalBee so their discovery keys are kept wanted.
const WANTED_BEE_GROUPS = [
  { names: ['profile'], open: createBee },
  { names: LOCAL_BEE_NAMES, open: createLocalBee },
]

const HEX64 = /^[0-9a-f]{64}$/i
const SHARE_PREFIX = 'share/'
const INSPECT_MS = 2000
const INSPECT_CONCURRENCY = 12

// Cores we can purge without risking live data:
//  - profiles / catalogs: bee cores positively identified by content, re-replicable.
//  - orphanDrives: a drive whose metadata core's discovery key is provably absent
//    from the complete, deterministic set of every current (own + member) drive
//    metadata key (everything in `wanted`). The blobs core is reached ONLY by
//    dereferencing that orphan metadata's own header, so a current drive's blobs
//    (reachable only via its current — hence kept — metadata) is never traversed.
// A naked blobs core (no metadata) is never matched here, so it is left intact.
const PURGEABLE = ['profiles', 'catalogs', 'orphanDrives']

const hex = (buf) => b4a.toString(buf, 'hex')
const dkOfKey = (keyHex) => hex(crypto.discoveryKey(b4a.from(keyHex, 'hex')))

async function addBeeCore(set, bee) {
  await bee.core.ready()
  set.add(hex(bee.core.discoveryKey))
}

// For a bee this function opened purely to read its discovery key. Shared handles — the live
// profile bee, the cached own catalog — go through addBeeCore instead: they belong to their
// owners, and closing one here would pull it out from under everything still using it.
async function addAndCloseBeeCore(set, bee) {
  try {
    await addBeeCore(set, bee)
  } finally {
    try { await bee.close() } catch {}
  }
}

// Own drives are loaded and local, so reading their blobs core key is cheap and
// reliable. Bounded only as defence; never opens a drive by key.
async function addLocalDriveCores(set, drive) {
  await drive.ready()
  set.add(hex(drive.core.discoveryKey))
  const blobs = await drive.getBlobs()
  if (blobs) set.add(hex(blobs.core.discoveryKey))
}

// Local read only: a current member's published catalog keys come from their
// already-replicated profile bee. No core.update (that waits on the swarm and is
// what made the scan exceed the IPC deadline) and no waiting block reads.
function localPeerCatalogKeys(profileKeyHex, spaceId) {
  // The accumulator IS the fallback: a peer bee is by definition partially replicated, so a
  // mid-stream BLOCK_NOT_AVAILABLE (the reason this read uses `wait: false`) is expected — and
  // the keys collected before it must still reach the wanted set. Returning an empty list there
  // would let the reclaim treat a live catalog as an orphan and purge it.
  const keys = []
  // sync:false keeps this a purely local read (no head pull), as before; withPeerBee adds the
  // close the bare open never had.
  return withPeerBee(profileKeyHex, async (bee) => {
    const prefix = SHARE_PREFIX + spaceId + '/'
    for await (const entry of bee.createReadStream({ gte: prefix, lt: prefix + '\xff' }, { wait: false })) {
      const ck = readCatalogKey(entry.value).keyHex
      if (ck && HEX64.test(ck)) keys.push(ck)
    }
    return keys
  }, { sync: false, fallback: keys })
}

// Built entirely from local/deterministic sources — no open-by-key, no swarm
// reads — so it never blocks. Peer meta cores are added by their deterministic
// discovery key; peer blobs cores only when the drive is already warmed in
// memory (an un-warmed peer's blobs core stays out of the purge set, which is
// safe because nothing here purges non-bee cores anyway).
// Every core a current member is entitled to keep. The member record's OWN catalog key matters as
// much as the ones on their share records: localPeerCatalogKeys streams share/<space>/ only, and a
// peer sharing nothing but LOOSE files publishes their catalog at loosecat*/<space> instead — so
// without this arm a live peer's catalog scans as an orphan and is purged while they are still a
// member.
async function addMemberCores(wanted, member, spaceId) {
  // The member's drive metadata core (deterministic discovery key). Overlay opens no peer drive,
  // so there is no cached blobs core to add here.
  if (member.driveKey && HEX64.test(member.driveKey)) wanted.add(dkOfKey(member.driveKey))
  if (!member.publicKey || !HEX64.test(member.publicKey)) return
  wanted.add(dkOfKey(member.publicKey))
  const memberCatalog = readCatalogKey(member).keyHex
  if (memberCatalog && HEX64.test(memberCatalog)) wanted.add(dkOfKey(memberCatalog))
  for (const ck of await localPeerCatalogKeys(member.publicKey, spaceId)) wanted.add(dkOfKey(ck))
}

const TIMED_OUT = Symbol('timed-out')

// Every core current state still needs. A GAP means the set is INCOMPLETE — something that should
// be in it is not — so "outside the set" no longer means "unneeded" and no category may be purged.
// Each failure below used to log a warning (one did not even do that) and let the sweep proceed on
// the shorter set, which is how a transient read failure became a permanent delete.
export async function buildWantedKeys({ openSystemBee = null } = {}) {
  const wanted = new Set()
  const gaps = []
  const gap = (stage, detail) => {
    gaps.push({ stage, detail: String(detail || '') })
    log.warn('wanted-set gap:', stage, '-', detail)
  }

  for (const { names, open } of WANTED_BEE_GROUPS) {
    for (const name of names) {
      try { await addAndCloseBeeCore(wanted, (openSystemBee || open)(name)) } catch (err) {
        gap('system-bee:' + name, err.message)
      }
    }
  }
  // Was a bare `catch {}`. The most dangerous gap in this function: the live profile bee's own core,
  // missing from `wanted`, classifies as 'profile' and is purged — the device's identity bee,
  // deleted by the sweep that exists to protect it.
  const profile = getProfileBee()
  if (profile) {
    try { await addBeeCore(wanted, profile) } catch (err) { gap('profile-bee', err.message) }
  } else {
    gap('profile-bee', 'not open')
  }

  try {
    const { getOverlayLocalDiscoveryKeys } = await import('../transfer/backends/overlay/overlay-instance.js')
    for (const dk of await getOverlayLocalDiscoveryKeys()) wanted.add(dk)
  } catch (err) {
    gap('overlay-cores', err.message)
  }

  // Deliberately NOT wrapped: a listSpaces() throw must propagate and fail the whole scan, which is
  // already the correct outcome — purgeLeftovers never runs, so nothing is deleted.
  for (const space of await listSpaces()) {
    const drive = getDrive(space.spaceId)
    if (drive) {
      // withReadTimeout RESOLVES the sentinel rather than rejecting, so the `.catch` below never
      // sees a timeout. A drive whose read merely took too long silently contributed nothing to
      // `wanted` and recorded nothing at all — the purest form of "couldn't read it just now"
      // reaching the delete.
      const res = await withReadTimeout(addLocalDriveCores(wanted, drive).then(() => true), INSPECT_MS, TIMED_OUT)
        .catch((err) => { gap('own-drive:' + space.spaceId, err.message); return null })
      if (res === TIMED_OUT) gap('own-drive:' + space.spaceId, 'read timed out after ' + INSPECT_MS + 'ms')
    } else if (space.status !== 'pending' && !space.leaving) {
      // A listed space whose drive is not loaded — a boot open that failed and is being retried
      // next boot (driveLoadError). Its cores are reachable only through the drive handle, so they
      // cannot be added here.
      gap('unopened-drive:' + space.spaceId, 'drive not loaded this boot')
    }
    try { await addBeeCore(wanted, await ownCatalog(space.spaceId)) } catch (err) {
      gap('own-catalog:' + space.spaceId, err.message)
    }

    // Wrapped where it never was: a throw here aborts the whole loop, so every space after this one
    // contributes nothing to `wanted` while still being listed.
    for (const member of (space.members || [])) {
      try { await addMemberCores(wanted, member, space.spaceId) } catch (err) {
        gap('member-cores:' + space.spaceId, err.message)
      }
    }
  }
  wanted.gaps = gaps
  return wanted
}

async function readSampleKeys(bee) {
  await bee.ready()
  const sample = []
  for await (const node of bee.createReadStream({ limit: 5 }, { wait: false })) {
    sample.push(node.key)
    if (sample.length >= 5) break
  }
  return sample
}

async function driveBlobs(drive) {
  await drive.ready()
  return await drive.getBlobs()
}

// Drive probes are opened at most once per process and reused across scans: a
// scan followed by a cleanup re-classifies, and opening a second Hyperdrive on
// the same cores either deadlocks or yields no blobs. Each probe runs on its own
// store session so closing it (only at purge time) never tears down the root db.
const probeDrives = new Map()

function probeDrive(store, dkHex, key, encryptionKey = null) {
  // Keyed by encryption too: the same core probed plaintext and under an SCK are different opens,
  // and handing back the plaintext one would read the encrypted drive's header as noise.
  const cacheKey = encryptionKey ? dkHex + ':enc' : dkHex
  let drive = probeDrives.get(cacheKey)
  if (!drive) {
    drive = new Hyperdrive(store.session(), key, encryptionKey ? { encryptionKey } : {})
    probeDrives.set(cacheKey, drive)
  }
  return drive
}

// Both cache keys: probeDrive files an SCK-encrypted probe under `<dk>:enc`, and since v1.7.0
// that is the common shape — looking up the bare key alone left the handle open across the
// RocksDB delete this exists to prevent.
async function closeProbe(dkHex) {
  for (const cacheKey of [dkHex, dkHex + ':enc']) {
    const drive = probeDrives.get(cacheKey)
    if (!drive) continue
    probeDrives.delete(cacheKey)
    try { await drive.close() } catch {}
  }
}

// Classify one non-wanted core, each step bounded so a core advertising blocks
// no longer served (owner gone) can't hang the scan.
//  - profile/catalog bee keys → leftover metadata.
//  - the overlay file-index bee → 'other' (protected: never a drive, never purged).
//  - a readable 'orphan' bee that opens as a Hyperdrive with a NON-EMPTY blobs core →
//    orphan drive. getBlobs() derives an empty blobs core for ANY bee opened as a
//    Hyperdrive, so the non-empty check is what separates a real content-bearing drive
//    from a plain bee — an empty derived core would false-positive to 'drive' → purge →
//    data loss. The Hyperdrive runs on a store *session* — Hyperdrive._close() closes
//    the corestore it is handed, so the root db must not be passed.
//  - everything else (raw blobs core, unreadable, a contentless bee) stays 'other'.
// Read a core's first keys under `encryptionKey` (null = plaintext) and name the shape they are.
// `readable` separates "opened, has blocks, made no sense" — worth retrying under a key — from
// "empty or unopenable", which no key can help.
async function sampleCore(store, dk, encryptionKey) {
  let metaBytes = 0
  let key = null
  let beeKind = null
  let readable = false

  const core = store.get({ discoveryKey: dk, ...(encryptionKey ? { encryptionKey } : {}) })
  try {
    const ready = await withReadTimeout(core.ready().then(() => true), INSPECT_MS, false)
    metaBytes = core.byteLength || 0
    key = core.key
    if (ready && core.length > 0) {
      readable = true
      const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
      const sample = await withReadTimeout(readSampleKeys(bee).catch(() => null), INSPECT_MS, null)
      if (sample !== null) beeKind = classifyBeeKind(sample)
    }
  } catch { /* unreadable → other */ } finally {
    try { await core.close() } catch {}
  }
  return { metaBytes, key, beeKind, readable }
}

async function inspectCore(store, dk) {
  let probe = await sampleCore(store, dk, null)
  let sck = null

  // Catalogs and space drives have been SCK-encrypted since v1.7.0, and one opened without its key
  // is indistinguishable from noise — which is why every encrypted leftover used to classify as
  // 'other' and outlive the reclaim. Retry under each key the vault holds; a leave keeps the entry,
  // so the key for a space whose leftovers these are is still there. Only the two shapes that are
  // actually SCK-encrypted are accepted, so a wrong key's garbage cannot be mistaken for a match.
  if (probe.readable && probe.beeKind === null) {
    for (const candidate of listContentKeys()) {
      const enc = await sampleCore(store, dk, candidate)
      if (enc.beeKind === 'catalog' || enc.beeKind === 'orphan') { probe = enc; sck = candidate; break }
    }
  }

  const { metaBytes, key, beeKind } = probe
  if (beeKind === 'profile' || beeKind === 'catalog') return { kind: beeKind, bytes: metaBytes }
  if (beeKind === 'file-index') return { kind: 'other', bytes: metaBytes }

  if (beeKind === 'orphan' && key) {
    try {
      const drive = probeDrive(store, hex(dk), key, sck)
      const blobs = await withReadTimeout(driveBlobs(drive), INSPECT_MS, undefined).catch(() => undefined)
      if (blobs && blobs.core.byteLength > 0) {
        return { kind: 'drive', blobsDkHex: hex(blobs.core.discoveryKey), bytes: metaBytes + blobs.core.byteLength }
      }
    } catch { /* not a drive */ }
  }
  return { kind: 'other', bytes: metaBytes }
}

export async function classifyLeftovers(opts = {}) {
  const store = getStore()
  const wanted = await buildWantedKeys(opts)

  const candidates = []
  let totalCores = 0
  for await (const dk of store.list()) {
    totalCores++
    const h = hex(dk)
    if (!wanted.has(h)) candidates.push(h)
  }

  const inspected = await mapLimit(candidates, INSPECT_CONCURRENCY, async (h) => {
    const r = await inspectCore(store, b4a.from(h, 'hex'))
    return { discoveryKeyHex: h, ...r }
  })

  const profiles = []
  const catalogs = []
  const orphanDrives = []
  for (const r of inspected) {
    if (r.kind === 'profile') profiles.push({ discoveryKeyHex: r.discoveryKeyHex, bytes: r.bytes })
    else if (r.kind === 'catalog') catalogs.push({ discoveryKeyHex: r.discoveryKeyHex, bytes: r.bytes })
    // No longer filtered here by the unopened-drive flag: an unopened drive is now one gap among
    // several, and a gap withholds EVERY category in purgeLeftovers. Filtering here would only hide
    // the finding from the scan's own report, which is the one place it can be diagnosed.
    else if (r.kind === 'drive') orphanDrives.push({ metaDkHex: r.discoveryKeyHex, blobsDkHex: r.blobsDkHex, bytes: r.bytes })
  }
  if (wanted.gaps.length) log.warn('the wanted set is incomplete —', wanted.gaps.map((g) => g.stage).join(', '))
  const sum = (a) => a.reduce((n, r) => n + r.bytes, 0)
  return {
    profiles: { count: profiles.length, bytes: sum(profiles), keys: profiles },
    catalogs: { count: catalogs.length, bytes: sum(catalogs), keys: catalogs },
    orphanDrives: { count: orphanDrives.length, bytes: sum(orphanDrives), keys: orphanDrives },
    totalBytes: sum(profiles) + sum(catalogs) + sum(orphanDrives),
    totalCores,
    gaps: wanted.gaps,
    scanComplete: wanted.gaps.length === 0,
    // Retained for existing callers; now derived from the same one rule.
    withheldDrives: wanted.gaps.length > 0,
  }
}

function purgeTargets(scan, allowed) {
  const dks = []
  for (const c of allowed) {
    if (c === 'orphanDrives') {
      for (const d of scan.orphanDrives.keys) {
        dks.push(d.metaDkHex)
        if (d.blobsDkHex) dks.push(d.blobsDkHex)
      }
    } else if (scan[c]) {
      for (const r of scan[c].keys) dks.push(r.discoveryKeyHex)
    }
  }
  return [...new Set(dks)]
}

export async function purgeLeftovers({ categories = PURGEABLE, onProgress, compact = true, openSystemBee = null } = {}) {
  const store = getStore()
  const db = store.storage.db
  const scan = await classifyLeftovers({ openSystemBee })
  const allowed = categories.filter((c) => PURGEABLE.includes(c))
  const dks = purgeTargets(scan, allowed)

  const decision = decideSweep({
    gaps: scan.gaps,
    targetCount: dks.length,
    totalCores: scan.totalCores,
    caps: getResourceCaps(),
  })
  if (!decision.allow) {
    // error, not warn: this is the sweep declining to delete user data on incomplete or
    // implausible evidence, and it is the one line that explains a boot that reclaimed nothing.
    log.error('leftover sweep refused:', decision.reason, '- targets', dks.length, 'of',
      scan.totalCores, 'cores, gaps:', scan.gaps.map((g) => g.stage).join(',') || 'none')
    await recordSweep({
      refused: decision.reason, targets: dks.length, totalCores: scan.totalCores,
      gaps: scan.gaps, categories: allowed, purged: 0,
    })
    return { purged: 0, freedEstimate: 0, withheldDrives: true, refused: decision.reason }
  }

  // Released only once the sweep is known to be going ahead: closing them on a refused pass would
  // drop the cache this module keeps so a scan and a later cleanup do not re-open the same drive.
  if (allowed.includes('orphanDrives')) {
    for (const d of scan.orphanDrives.keys) await closeProbe(d.metaDkHex)
  }
  let purged = 0
  const purgedDks = []
  for (const dkHex of dks) {
    if (onProgress) onProgress('purging', { done: purged, total: dks.length })
    try {
      await purgeCoreDk(store, db, dkHex)
      purged++
      purgedDks.push(dkHex)
    } catch (err) {
      log.debug('leftover purge skip:', dkHex.slice(0, 12), err.message)
    }
  }
  await recordSweep({
    refused: null, targets: dks.length, totalCores: scan.totalCores,
    gaps: [], categories: allowed, purged, purgedDks,
  })
  // Tombstoning the cores is what makes the leave effective; the compaction only returns the
  // bytes. A boot-path caller passes compact:false rather than block startup on a full-range
  // pass — space-leave.js defers it for the same reason.
  if (purged > 0 && compact) {
    if (onProgress) onProgress('compacting', { done: purged, total: dks.length })
    await compactStore()
  }
  const freedEstimate = allowed.reduce((n, c) => n + (scan[c]?.bytes || 0), 0)
  return { purged, freedEstimate, withheldDrives: scan.withheldDrives, refused: null }
}

// The cores a member brought with them: their profile bee, and the one catalog they advertise per
// space. ownCatalog is a single bee per (owner, space), published into both the member record and
// their share records, so this one key covers their loose files and folders alike.
function peerCoreKeys(member) {
  return [member?.publicKey, readCatalogKey(member).keyHex].filter((k) => k && HEX64.test(k))
}

// A departed peer's cores are only leftover if that peer appears in no other active space. No
// compaction here: leave already compacts in purgeSpaceDrive, and these are metadata bees worth
// a few KB, reclaimed on the next pass.
export async function forgetUnreferencedPeerCores(removedMembers) {
  const store = getStore()
  const db = store.storage.db
  const stillReferenced = new Set()
  for (const space of await listSpaces()) {
    // A peer we share ANOTHER space with keeps both cores — the catalog key is per (member,
    // space), so a member dropped from one space can still be advertising in the next.
    for (const member of (space.members || [])) {
      for (const keyHex of peerCoreKeys(member)) stillReferenced.add(dkOfKey(keyHex))
    }
  }
  let purged = 0
  for (const member of (removedMembers || [])) {
    for (const keyHex of peerCoreKeys(member)) {
      const dk = dkOfKey(keyHex)
      if (stillReferenced.has(dk)) continue
      try {
        await purgeCoreDk(store, db, dk)
        purged++
      } catch (err) {
        log.debug('peer core purge skip:', err.message)
      }
    }
  }
  return { purged }
}
