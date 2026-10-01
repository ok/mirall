// The catalog cores a space holds on this device, resolved from local state only — no swarm read,
// and no core opened that is not already on disk — so both the leftover sweep's wanted set and the
// storage breakdown can afford it.
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { beeDiscoveryKeyHex, hasCoreForKey } from '../core/store.js'
import { withPeerBee } from '../spaces/peer-bee.js'
import { readCatalogKey } from '../shares/catalog-keys.js'
import { catalogNameForSpace, plaintextCatalogName } from '../shares/own-catalog.js'
import { prefixRange } from '../core/bee-keys.js'
import { mapLimit } from '../core/concurrency.js'
/** @import { StoredSpace } from '../spaces/space.js' */
/** @import { SpaceMember } from '../contract/responses.js' */

const HEX64 = /^[0-9a-f]{64}$/i
const SHARE_PREFIX = 'share/'
const MEMBER_CONCURRENCY = 8

export const dkOfKey = (keyHex) => b4a.toString(crypto.discoveryKey(b4a.from(keyHex, 'hex')), 'hex')

// Local read only: a current member's published catalog keys come from their
// already-replicated profile bee. No core.update (that waits on the swarm and is
// what made the scan exceed the IPC deadline) and no waiting block reads. A profile never
// replicated has no rows to read, and opening it by key would create its core.
async function localPeerCatalogKeys(profileKeyHex, spaceId) {
  if (!await hasCoreForKey(profileKeyHex)) return []
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

// A member's catalog keys in one space. The member record's own key matters as much as the ones on
// their share records: localPeerCatalogKeys streams share/<space>/ only, and a peer sharing nothing
// but LOOSE files publishes their catalog at loosecat*/<space> instead.
/** @param {SpaceMember} member @param {string} spaceId @returns {Promise<string[]>} */
export async function memberCatalogKeys(member, spaceId) {
  if (!member.publicKey || !HEX64.test(member.publicKey)) return []
  const keys = []
  const recordKey = readCatalogKey(member).keyHex
  if (recordKey && HEX64.test(recordKey)) keys.push(recordKey)
  keys.push(...await localPeerCatalogKeys(member.publicKey, spaceId))
  return keys
}

// Our own catalog is named rather than keyed, so its discovery key is derived without opening it:
// an open would create the core, and a legacy space's own catalog cannot be opened at all. A
// legacy space's real catalog is the pre-encryption plaintext core, so both names are resolved.
/** @param {StoredSpace} space @returns {Promise<{ own: string[], members: string[] }>} */
export async function spaceCatalogCores(space) {
  const own = []
  for (const name of [catalogNameForSpace(space.spaceId, space), plaintextCatalogName(space.spaceId, space)]) {
    const dk = await beeDiscoveryKeyHex(name)
    if (dk) own.push(dk)
  }
  const perMember = await mapLimit(space.members || [], MEMBER_CONCURRENCY, (member) => memberCatalogKeys(member, space.spaceId))
  const members = new Set(perMember.flat().map(dkOfKey))
  for (const dk of own) members.delete(dk)
  return { own, members: [...members] }
}
