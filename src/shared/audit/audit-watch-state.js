// The durable memory of the two watches, kept in the audit bee. The peer-bee watermarks are
// working state — a purge keeps them, or every peer's history replays. The recorded peer-subject
// and device-connectivity states are observed state — a purge drops them and the standing fact
// is restated once. All of it is durable so a restart does not re-emit an act whose record
// merely got re-written, or write the same outage row on every launch on the same bad network.
import { auditBee } from './audit-log.js'
import { STATE_OFF } from './peer-records-observer.js'
import { NSTATE, PSTATE, SEEN } from './audit-keys.js'
import { prefixRange } from '../core/bee-keys.js'

// Absent means "never observed" — the caller must adopt the current version as a baseline and
// emit nothing, or first contact would flood the log with history.
export async function getSeenVersion(beeId) {
  const bee = auditBee()
  if (!bee) return null
  const node = await bee.get(SEEN + beeId)
  return Number.isInteger(node?.value) ? node.value : null
}

export async function setSeenVersion(beeId, version) {
  const bee = auditBee()
  if (!bee || !Number.isInteger(version)) return
  await bee.put(SEEN + beeId, version)
}

export async function readSeenVersions() {
  const bee = auditBee()
  const out = []
  if (!bee) return out
  for await (const entry of bee.createReadStream(prefixRange(SEEN))) out.push([entry.key, entry.value])
  return out
}

export async function writeSeenVersions(entries) {
  const bee = auditBee()
  if (!bee) return
  for (const [key, value] of entries) await bee.put(key, value)
}

export async function getPeerSubjectState(key) {
  const bee = auditBee()
  if (!bee) return null
  const node = await bee.get(PSTATE + key)
  return typeof node?.value === 'string' ? node.value : null
}

// 'off' is the absence of a subject, so the key is dropped instead of storing a tombstone that
// lives forever: a peer that shares and unshares 50k loose files would otherwise keep 50k keys.
export async function setPeerSubjectState(key, state) {
  const bee = auditBee()
  if (!bee) return
  if (state === STATE_OFF) await bee.del(PSTATE + key)
  else await bee.put(PSTATE + key, state)
}

export async function getNetworkState() {
  const bee = auditBee()
  if (!bee) return null
  const node = await bee.get(NSTATE)
  return node?.value && typeof node.value === 'object' ? node.value : null
}

// Healthy is the absence of an episode, so the key is dropped rather than tombstoned.
export async function setNetworkState(state) {
  const bee = auditBee()
  if (!bee) return
  if (!state) await bee.del(NSTATE)
  else await bee.put(NSTATE, state)
}
