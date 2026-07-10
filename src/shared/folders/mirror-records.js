// Mirror-participation records — the `mirror/<spaceId>/<shareId>` rows in profile bees. Written by
// the peer that mirrors a share (under the `caps/folder-mirrors` capability flag) so the share's
// owner, and any member, can see who is mirroring it and its sync state (syncing | synced | paused):
// a durable, replicated fact that survives the owner being offline. Removal is a soft tombstone
// (unmirroredAt) so a reader tells "stopped mirroring" apart from "not replicated yet". Peers' rows
// are read cap-gated with bounded reads, so an offline member can't stall a caller.
import b4a from 'b4a'
import { getProfileBee, openProfileBee } from '../spaces/profile.js'
import { withReadTimeout, peerReadTimeoutMs } from '../core/with-timeout.js'
import { createLogger } from '../core/logger.js'

const log = createLogger('mirror-records')

const MIRRORS_CAP = 'caps/folder-mirrors'
export const MIRROR_PREFIX = 'mirror/'

const keyFor = (spaceId, shareId) => MIRROR_PREFIX + spaceId + '/' + shareId

// Serialize read-modify-write per record key: the state is written from several lifecycle points
// (mount, pause/resume, the materialize tick, unmount) that can overlap, and a bare get→put would
// let a stale tick clobber a pause or resurrect a tombstone. One chain per key makes each mutation
// atomic w.r.t. the others (the same discipline space.js uses for member writes).
const writeChains = new Map()
function serialize(key, op) {
  const prev = writeChains.get(key) ?? Promise.resolve()
  const next = prev.then(op, op)
  writeChains.set(key, next.then(() => {}, () => {}))
  return next
}

export async function ensureFolderMirrorsCap() {
  const bee = getProfileBee()
  const entry = await bee.get(MIRRORS_CAP)
  if (!entry?.value) await bee.put(MIRRORS_CAP, true)
}

export function publishMirror(spaceId, shareId, { state = 'syncing', mountedAt = Date.now() } = {}) {
  const key = keyFor(spaceId, shareId)
  return serialize(key, async () => {
    await ensureFolderMirrorsCap()
    await getProfileBee().put(key, { shareId, state, mountedAt, ts: Date.now() })
    return true
  })
}

// Create the record only if it is absent or tombstoned — used by boot resume so a mount that
// predates this feature (or whose mount-time publish failed) still gains a participation record,
// without re-stamping (and re-broadcasting) a healthy one on every restart.
export function ensureMirror(spaceId, shareId, { state = 'syncing', mountedAt = Date.now() } = {}) {
  const key = keyFor(spaceId, shareId)
  return serialize(key, async () => {
    const bee = getProfileBee()
    const entry = await bee.get(key)
    if (entry?.value && !entry.value.unmirroredAt) return false
    await ensureFolderMirrorsCap()
    await bee.put(key, { shareId, state, mountedAt, ts: Date.now() })
    return true
  })
}

// state is one of 'syncing' | 'synced' | 'paused'. Returns whether the record changed, so a caller
// driving this from the poll loop only re-broadcasts on a genuine transition (not every tick).
export function setMirrorState(spaceId, shareId, state) {
  const key = keyFor(spaceId, shareId)
  return serialize(key, async () => {
    const bee = getProfileBee()
    const entry = await bee.get(key)
    if (!entry?.value || entry.value.unmirroredAt || entry.value.state === state) return false
    await bee.put(key, { ...entry.value, state, ts: Date.now() })
    return true
  })
}

export function tombstoneMirror(spaceId, shareId) {
  const key = keyFor(spaceId, shareId)
  return serialize(key, async () => {
    const bee = getProfileBee()
    const entry = await bee.get(key)
    if (!entry?.value || entry.value.unmirroredAt) return false
    await bee.put(key, { ...entry.value, unmirroredAt: Date.now(), ts: Date.now() })
    return true
  })
}

export async function readOwnMirrors(spaceId) {
  const bee = getProfileBee()
  const prefix = MIRROR_PREFIX + spaceId + '/'
  const out = []
  for await (const entry of bee.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    if (!entry.value.unmirroredAt) out.push(entry.value)
  }
  return out
}

export function readOwnMirror(spaceId, shareId) {
  return getProfileBee().get(keyFor(spaceId, shareId)).then((e) => (e?.value && !e.value.unmirroredAt ? e.value : null))
}

export async function readPeerMirrors(profileKeyHex, spaceId, timeoutMs = peerReadTimeoutMs()) {
  try {
    return await withReadTimeout(collectPeerMirrors(profileKeyHex, spaceId), timeoutMs, null)
  } catch (err) {
    log.warn('readPeerMirrors failed for', profileKeyHex.slice(0, 16) + '...', '-', err.message)
    return null
  }
}

// Single-record point read of one peer's mirror row for a specific share — avoids a whole-space
// range scan when the caller only wants one share (the per-share widget path).
export async function readPeerMirror(profileKeyHex, spaceId, shareId, timeoutMs = peerReadTimeoutMs()) {
  try {
    return await withReadTimeout(collectPeerMirror(profileKeyHex, spaceId, shareId), timeoutMs, null)
  } catch (err) {
    log.warn('readPeerMirror failed for', profileKeyHex.slice(0, 16) + '...', '-', err.message)
    return null
  }
}

async function openPeerBeeWithCap(profileKeyHex) {
  const bee = openProfileBee(b4a.from(profileKeyHex, 'hex'))
  await bee.ready()
  await bee.core.update({ wait: true })
  const cap = await bee.get(MIRRORS_CAP)
  return cap?.value ? bee : null
}

async function collectPeerMirrors(profileKeyHex, spaceId) {
  const bee = await openPeerBeeWithCap(profileKeyHex)
  if (!bee) return null
  const prefix = MIRROR_PREFIX + spaceId + '/'
  const out = []
  for await (const entry of bee.createReadStream({ gte: prefix, lt: prefix + '\xff' })) {
    if (!entry.value.unmirroredAt) out.push(entry.value)
  }
  return out
}

async function collectPeerMirror(profileKeyHex, spaceId, shareId) {
  const bee = await openPeerBeeWithCap(profileKeyHex)
  if (!bee) return null
  const entry = await bee.get(keyFor(spaceId, shareId))
  return entry?.value && !entry.value.unmirroredAt ? entry.value : null
}
