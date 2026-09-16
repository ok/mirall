// Groups the frame's relayed connections for the Network Status section. The configured relay is
// one group carrying everyone it relays; an adopted relay is one group per peer, because the peer
// on that connection is the one who offered it.
/** @import { RelayedConnection, RelayStatus, RelayPlane } from '../types/types.js' */
/** @import { TFunction } from 'i18next' */
import { shortKey } from './audit-row.js'

/** @typedef {'own' | 'adopted'} RelayVia */
/** @typedef {{ peerKey: string, displayName: string | null, since: number, planes: RelayPlane[] }} RelayPerson */
/** @typedef {{ key: string, relayKey: string, via: RelayVia, providerName: string | null, people: RelayPerson[] }} RelayGroup */
/** @typedef {'off' | 'none' | 'used'} RelayState */

export const MAX_NAMES_SHOWN = 5

/** @param {RelayedConnection[]} connections @returns {RelayGroup[]} */
export function relayGroups(connections) {
  /** @type {Map<string, RelayGroup>} */
  const byKey = new Map()
  for (const c of connections) {
    const key = c.via === 'own' ? c.relayKey : `${c.relayKey}|${c.peerKey}`
    let group = byKey.get(key)
    if (!group) {
      group = { key, relayKey: c.relayKey, via: c.via, providerName: c.via === 'adopted' ? c.displayName : null, people: [] }
      byKey.set(key, group)
    }
    const person = group.people.find((p) => p.peerKey === c.peerKey)
    if (person) {
      person.planes.push(c.plane)
      person.since = Math.min(person.since, c.since)
    } else {
      group.people.push({ peerKey: c.peerKey, displayName: c.displayName, since: c.since, planes: [c.plane] })
    }
  }
  return [...byKey.values()].sort((a, b) => (a.via === b.via ? 0 : a.via === 'own' ? -1 : 1))
}

/** @param {'off' | 'auto' | 'always'} relayMode @param {RelayStatus} relay @returns {RelayState} */
export function relayState(relayMode, relay) {
  if (relay.connections.length > 0) return 'used'
  return relayMode === 'off' ? 'off' : 'none'
}

/** @param {RelayStatus} relay */
export function relayedPeopleCount(relay) {
  return new Set(relay.connections.map((c) => c.peerKey)).size
}

const PLANE_LABEL = {
  control: 'networkStatus.relayed.plane.control',
  content: 'networkStatus.relayed.plane.content',
  both: 'networkStatus.relayed.plane.both',
}

/** @param {RelayPerson} person @param {TFunction} t */
function personLabel(person, t) {
  const name = person.displayName ?? shortKey(person.peerKey) ?? ''
  const planes = person.planes.includes('control') && person.planes.includes('content') ? 'both' : person.planes[0]
  return `${name} (${t(PLANE_LABEL[planes])})`
}

/** @param {RelayPerson[]} people @param {TFunction} t */
export function peopleLabel(people, t) {
  const names = people.map((p) => personLabel(p, t))
  if (names.length <= MAX_NAMES_SHOWN) return names.join(' · ')
  return t('networkStatus.relayed.moreNames', {
    shown: names.slice(0, MAX_NAMES_SHOWN).join(' · '),
    count: names.length - MAX_NAMES_SHOWN,
  })
}

/** @param {'open' | 'private'} kind */
export function relayKindClasses(kind) {
  return kind === 'private' ? 'bg-secondary-container text-on-secondary-container' : 'bg-info text-on-info'
}
