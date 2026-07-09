// Share records — the `share/<spaceId>/<shareId>` rows in profile bees. A record points
// at a catalog (key + content mode); the file listings themselves live in share-catalog.js.
// Own records are written to the local profile bee (under the `caps/folder-shares`
// capability flag); peers' records are read from their replicated profile bees with
// bounded reads, so an offline member can't stall a caller.
import b4a from 'b4a'
import { getProfileBee, openProfileBee } from '../spaces/profile.js'
import { withReadTimeout, peerReadTimeoutMs } from '../core/with-timeout.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('shares')

const SHARES_CAP = 'caps/folder-shares'
export const SHARE_PREFIX = 'share/'

export async function ensureSharesCap() {
  const bee = getProfileBee()
  const entry = await bee.get(SHARES_CAP)
  if (!entry?.value) await bee.put(SHARES_CAP, true)
}

export async function publishShare(spaceId, share) {
  await ensureSharesCap()
  await getProfileBee().put(SHARE_PREFIX + spaceId + '/' + share.id, share)
}

export async function tombstoneShare(spaceId, shareId) {
  const bee = getProfileBee()
  const key = SHARE_PREFIX + spaceId + '/' + shareId
  const entry = await bee.get(key)
  if (!entry) return
  await bee.put(key, { ...entry.value, deletedAt: Date.now() })
}

export async function readOwnShares(spaceId) {
  const bee = getProfileBee()
  const prefix = SHARE_PREFIX + spaceId + '/'
  const shares = []
  for await (const entry of bee.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    if (!entry.value.deletedAt) shares.push(entry.value)
  }
  return shares
}

export async function readPeerShares(profileKeyHex, spaceId, timeoutMs = peerReadTimeoutMs()) {
  try {
    // Whole read is bounded by `timeoutMs`: the post-update bee.get / createReadStream below
    // wait (hyperbee default) for blocks the peer's profile bee advertises but hasn't replicated
    // to us; an offline peer's never arrive, so without a deadline this hangs forever. The
    // interactive list paths (share:list, files:list) pass the short interactiveReadTimeoutMs so
    // one unreachable member can't freeze the view — they self-heal via event:shares-updated once
    // the bee replicates. Mirror / foreign-folder callers keep the full peerReadTimeoutMs default,
    // where correctness needs the longer wait.
    return await withReadTimeout(collectPeerShares(profileKeyHex, spaceId), timeoutMs, null)
  } catch (err) {
    log.warn('readPeerShares failed for', profileKeyHex.slice(0, 16) + '...', '-', err.message)
    return null
  }
}

async function collectPeerShares(profileKeyHex, spaceId) {
  const bee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
  await bee.ready()
  await bee.core.update({ wait: true })
  const cap = await bee.get(SHARES_CAP)
  if (!cap?.value) return null
  const prefix = SHARE_PREFIX + spaceId + '/'
  const shares = []
  for await (const entry of bee.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    if (!entry.value.deletedAt) shares.push(entry.value)
  }
  return shares
}

// Raw single-share lookup on a peer's profile bee, INCLUDING tombstones —
// readPeerShares hides deleted shares, but a mirror needs to tell "the owner
// deleted this share" (entry present with deletedAt) apart from "not replicated
// yet / unreadable" (no entry). Returns the stored share value, or null.
export async function readPeerShareEntry(profileKeyHex, spaceId, shareId) {
  try {
    // Same unbounded-block-wait hazard as readPeerShares: a bare bee.get on an
    // offline peer's un-replicated entry blocks forever. A timeout maps to null,
    // which the caller already reads as "not replicated yet / unreadable".
    return await withReadTimeout(loadPeerShareEntry(profileKeyHex, spaceId, shareId), peerReadTimeoutMs(), null)
  } catch (err) {
    log.warn('readPeerShareEntry failed for', profileKeyHex.slice(0, 16) + '...', '-', err.message)
    return null
  }
}

async function loadPeerShareEntry(profileKeyHex, spaceId, shareId) {
  const bee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
  await bee.ready()
  // Pull the remote head before reading: a read-only bee opened by key starts at
  // length 0, so a bare get would miss a tombstone the owner has already written
  // (it'd read as "not replicated"). The outer withReadTimeout still bounds this.
  await bee.core.update({ wait: true })
  const entry = await bee.get(SHARE_PREFIX + spaceId + '/' + shareId)
  return entry?.value ?? null
}

export function isValidShareName(name) {
  if (typeof name !== 'string') return false
  const trimmed = name.trim()
  if (trimmed.length === 0 || trimmed.length > 255) return false
  if (/[\\/<>:"|?*\x00-\x1f]/.test(trimmed)) return false
  if (trimmed === '.' || trimmed === '..') return false
  return true
}

export function generateShareId() {
  const ts = Date.now().toString(36)
  const rand = Math.random().toString(36).slice(2, 10)
  return ts + '-' + rand
}
