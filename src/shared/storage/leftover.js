// Leftover-core reclamation: build the deterministic set of every core current state
// still needs (the "wanted" set), classify each store core outside it by content
// sniffing, and purge only the provably-safe categories. Conservative by design —
// anything unidentified stays on disk.
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import Hyperbee from 'hyperbee'
import { createLogger } from '../core/logger.js'
import { getStore, createBee, createLocalBee, LOCAL_BEE_NAMES } from '../core/store.js'
import { purgeCoreDk } from './core-purge.js'
import { listSpaces } from '../spaces/space.js'
import { getProfileBee, withPeerBee } from '../spaces/profile.js'
import { readCatalogKey } from '../shares/catalog-keys.js'
import { ownCatalog } from '../shares/own-catalog.js'
import { compactStore } from './compaction.js'
import { withReadTimeout } from '../core/with-timeout.js'
import { mapLimit } from '../core/concurrency.js'
import { classifyBeeKind } from '../sweep/sweep-rules.js'
import { decideSweep } from '../sweep/sweep-rules.js'
import { recordSweep } from './sweep-journal.js'
import { getSweepPurgeGuard } from '../core/runtime-config.js'
import { listContentKeys } from '../spaces/space-keys.js'
import { prefixRange } from '../core/bee-keys.js'

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

// Cores we can purge without risking live data: profile and catalog bee cores, positively
// identified by content and re-replicable. Anything else is left intact.
const PURGEABLE = ['profiles', 'catalogs']

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

// Local read only: a current member's published catalog keys come from their
// already-replicated profile bee. No core.update (that waits on the swarm and is
// what made the scan exceed the IPC deadline) and no waiting block reads.
function localPeerCatalogKeys(profileKeyHex, spaceId) {
  // The accumulator IS the fallback: a peer bee is by definition partially replicated, so a
  // mid-stream BLOCK_NOT_AVAILABLE (the reason this read uses `wait: false`) is expected — and
  // the keys collected before it must still reach the wanted set. Returning an empty list there
  // would let the reclaim treat a live catalog as an orphan and purge it.
  const keys = []
  // sync:false keeps this a purely local read (no head pull); withPeerBee owns the close.
  return withPeerBee(profileKeyHex, async (bee) => {
    const prefix = SHARE_PREFIX + spaceId + '/'
    for await (const entry of bee.createReadStream(prefixRange(prefix), { wait: false })) {
      const ck = readCatalogKey(entry.value).keyHex
      if (ck && HEX64.test(ck)) keys.push(ck)
    }
    return keys
  }, { sync: false, fallback: keys })
}

// Every core a current member is entitled to keep. The member record's OWN catalog key matters as
// much as the ones on their share records: localPeerCatalogKeys streams share/<space>/ only, and a
// peer sharing nothing but LOOSE files publishes their catalog at loosecat*/<space> instead — so
// without this arm a live peer's catalog scans as an orphan and is purged while they are still a
// member.
async function addMemberCores(wanted, member, spaceId) {
  if (!member.publicKey || !HEX64.test(member.publicKey)) return
  wanted.add(dkOfKey(member.publicKey))
  const memberCatalog = readCatalogKey(member).keyHex
  if (memberCatalog && HEX64.test(memberCatalog)) wanted.add(dkOfKey(memberCatalog))
  for (const ck of await localPeerCatalogKeys(member.publicKey, spaceId)) wanted.add(dkOfKey(ck))
}

// Every core current state still needs, built from local, deterministic sources only — no
// open-by-key, no swarm reads — so it never blocks. A GAP means the set is INCOMPLETE — something
// that should be in it is not — so "outside the set" no longer means "unneeded"; decideSweep
// refuses on gaps.
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
  // The most dangerous gap: the live profile bee's own core, missing from `wanted`, classifies as
  // 'profile' — the device's identity bee, purged by the sweep that exists to protect it.
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
    try { await addBeeCore(wanted, await ownCatalog(space.spaceId)) } catch (err) {
      gap('own-catalog:' + space.spaceId, err.message)
    }

    // Per member: one bad member must not stop every later space from reaching `wanted`.
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

// Read a core's first keys under `encryptionKey` (null = plaintext) and name the shape they are.
// `readable` separates "opened, has blocks, made no sense" — worth retrying under a key — from
// "empty or unopenable", which no key can help.
async function sampleCore(store, dk, encryptionKey) {
  let metaBytes = 0
  let beeKind = null
  let readable = false

  const core = store.get({ discoveryKey: dk, ...(encryptionKey ? { encryptionKey } : {}) })
  try {
    const ready = await withReadTimeout(core.ready().then(() => true), INSPECT_MS, false)
    metaBytes = core.byteLength || 0
    if (ready && core.length > 0) {
      readable = true
      const bee = new Hyperbee(core, { keyEncoding: 'utf-8', valueEncoding: 'json' })
      const sample = await withReadTimeout(readSampleKeys(bee).catch(() => null), INSPECT_MS, null)
      if (sample !== null) beeKind = classifyBeeKind(sample)
    }
  } catch { /* unreadable → other */ } finally {
    try { await core.close() } catch {}
  }
  return { metaBytes, beeKind, readable }
}

// Classify one non-wanted core, each step bounded so a core advertising blocks no longer served
// (owner gone) can't hang the scan. Profile and catalog bee keys are leftover metadata; everything
// else — the overlay file-index bee, a raw blobs core, an unreadable or unrecognised core — stays
// 'other' and is never purged.
async function inspectCore(store, dk) {
  let probe = await sampleCore(store, dk, null)

  // An SCK-encrypted catalog reads as noise without its key. Retry under each key the vault holds —
  // a leave keeps the entry, so the key for a space whose leftovers these are is still there. Only
  // a catalog is accepted, so a wrong key's garbage cannot be mistaken for a match.
  if (probe.readable && probe.beeKind === null) {
    for (const candidate of listContentKeys()) {
      const enc = await sampleCore(store, dk, candidate)
      if (enc.beeKind === 'catalog') { probe = enc; break }
    }
  }

  const { metaBytes, beeKind } = probe
  if (beeKind === 'profile' || beeKind === 'catalog') return { kind: beeKind, bytes: metaBytes }
  return { kind: 'other', bytes: metaBytes }
}

/** @internal */
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
  for (const r of inspected) {
    if (r.kind === 'profile') profiles.push({ discoveryKeyHex: r.discoveryKeyHex, bytes: r.bytes })
    else if (r.kind === 'catalog') catalogs.push({ discoveryKeyHex: r.discoveryKeyHex, bytes: r.bytes })
  }
  if (wanted.gaps.length) log.warn('the wanted set is incomplete —', wanted.gaps.map((g) => g.stage).join(', '))
  const sum = (a) => a.reduce((n, r) => n + r.bytes, 0)
  return {
    profiles: { count: profiles.length, bytes: sum(profiles), keys: profiles },
    catalogs: { count: catalogs.length, bytes: sum(catalogs), keys: catalogs },
    totalBytes: sum(profiles) + sum(catalogs),
    totalCores,
    gaps: wanted.gaps,
    scanComplete: wanted.gaps.length === 0,
  }
}

function purgeTargets(scan, allowed) {
  return [...new Set(allowed.flatMap((c) => scan[c].keys.map((r) => r.discoveryKeyHex)))]
}

export async function purgeLeftovers({ categories = PURGEABLE, onProgress, compact = true, openSystemBee = null } = {}) {
  const store = getStore()
  const scan = await classifyLeftovers({ openSystemBee })
  const allowed = categories.filter((c) => PURGEABLE.includes(c))
  const dks = purgeTargets(scan, allowed)

  const decision = decideSweep({
    gaps: scan.gaps,
    targetCount: dks.length,
    totalCores: scan.totalCores,
    caps: getSweepPurgeGuard(),
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
    return { purged: 0, freedEstimate: 0, scanComplete: false, refused: decision.reason }
  }

  let purged = 0
  const purgedDks = []
  for (const dkHex of dks) {
    if (onProgress) onProgress('purging', { done: purged, total: dks.length })
    try {
      await purgeCoreDk(store, dkHex)
      purged++
      purgedDks.push(dkHex)
    } catch (err) {
      // A core the sweep decided to delete and could not is a store that no longer matches its
      // own journal, so it is reported rather than swallowed.
      log.warn('leftover purge failed:', dkHex.slice(0, 12), err.message)
    }
  }
  await recordSweep({
    refused: null, targets: dks.length, totalCores: scan.totalCores,
    gaps: scan.gaps, categories: allowed, purged, purgedDks,
  })
  // Tombstoning the cores is what makes the leave effective; the compaction only returns the
  // bytes. A boot-path caller passes compact:false rather than block startup on a full-range
  // pass — space-leave.js defers it for the same reason.
  if (purged > 0 && compact) {
    if (onProgress) onProgress('compacting', { done: purged, total: dks.length })
    await compactStore()
  }
  const freedEstimate = allowed.reduce((n, c) => n + (scan[c]?.bytes || 0), 0)
  return { purged, freedEstimate, scanComplete: scan.scanComplete, refused: null }
}

// The cores a member brought with them: their profile bee, and the one catalog they advertise per
// space. ownCatalog is a single bee per (owner, space), published into both the member record and
// their share records, so this one key covers their loose files and folders alike.
function peerCoreKeys(member) {
  return [member?.publicKey, readCatalogKey(member).keyHex].filter((k) => k && HEX64.test(k))
}

// A departed peer's cores are only leftover if that peer appears in no other active space. No
// compaction here: these are metadata bees worth a few KB, collected by whatever compaction runs next.
export async function forgetUnreferencedPeerCores(removedMembers) {
  const store = getStore()
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
        await purgeCoreDk(store, dk)
        purged++
      } catch (err) {
        log.warn('peer core purge failed:', dk.slice(0, 12), err.message)
      }
    }
  }
  return { purged }
}
