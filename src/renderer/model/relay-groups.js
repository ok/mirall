// Groups the frame's relayed connections for the Network Status section. The configured relay is
// one group carrying everyone it relays; an adopted relay is one group per peer, because the peer
// on that connection is the one who offered it. Folding is by person: the control and content
// sockets carry different Noise keys, so folding by those would show one person twice.
/** @import { RelayedConnection, RelayStatus, RelayPlane } from '../types/types.js' */
/** @import { TFunction } from 'i18next' */
import { shortKey } from './audit-row.js'

/** @typedef {'own' | 'adopted'} RelayVia */
/** @import { PersonKey, NoiseKey } from '../../shared/contract/principals.js' */
/** @typedef {{ foldKey: PersonKey | NoiseKey, noiseKey: NoiseKey, displayName: string | null, since: number, planes: RelayPlane[] }} RelayPerson */
/** @typedef {{ key: string, relayKey: string, via: RelayVia, providerName: string | null, people: RelayPerson[] }} RelayGroup */
/** @typedef {'off' | 'none' | 'used'} RelayState */

export const MAX_NAMES_SHOWN = 5

/** @param {RelayedConnection[]} connections @returns {RelayGroup[]} */
export function relayGroups(connections) {
  /** @type {Map<string, RelayGroup>} */
  const byKey = new Map()
  for (const c of connections) {
    const foldKey = foldKeyOf(c)
    const key = c.via === 'own' ? c.relayKey : `${c.relayKey}|${foldKey}`
    let group = byKey.get(key)
    if (!group) {
      group = { key, relayKey: c.relayKey, via: c.via, providerName: c.via === 'adopted' ? c.displayName : null, people: [] }
      byKey.set(key, group)
    }
    const person = group.people.find((p) => p.foldKey === foldKey)
    if (person) {
      person.planes.push(c.plane)
      person.since = Math.min(person.since, c.since)
    } else {
      group.people.push({ foldKey, noiseKey: c.noiseKey, displayName: c.displayName, since: c.since, planes: [c.plane] })
    }
  }
  return [...byKey.values()].sort((a, b) => (a.via === b.via ? 0 : a.via === 'own' ? -1 : 1))
}

/** @param {'off' | 'auto' | 'always'} relayMode @param {RelayStatus} relay @returns {RelayState} */
export function relayState(relayMode, relay) {
  if (relay.connections.length > 0) return 'used'
  return relayMode === 'off' ? 'off' : 'none'
}

// What one row folds by: the person, once the handshake has bound one to the socket. A socket seen
// before that has no person yet, so it folds under its own Noise key — one row per socket until the
// identity arrives, rather than a row that claims to be nobody. Hence not a PersonKey.
/** @param {RelayedConnection} c @returns {PersonKey | NoiseKey} */
function foldKeyOf(c) {
  return c.personKey ?? c.noiseKey
}

/** @param {RelayStatus} relay */
export function relayedPeopleCount(relay) {
  return new Set(relay.connections.map(foldKeyOf)).size
}

const PLANE_LABEL = {
  control: 'networkStatus.relayed.plane.control',
  content: 'networkStatus.relayed.plane.content',
  both: 'networkStatus.relayed.plane.both',
}

/** @param {RelayPerson} person @param {TFunction} t */
function personLabel(person, t) {
  const name = person.displayName ?? shortKey(person.noiseKey) ?? ''
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
