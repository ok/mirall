// The Advanced details screen as data: its sections and their rows. Derived here rather than in
// the screen, so a row is described once — what it is called, how it is formatted, and whether it
// is masked — and the screen only renders what this returns.
/** @import { NetworkStatusScreen } from '../types/types.js' */
/** @import { TFunction } from 'i18next' */
import { DASH, formatNumber, formatRelativeTime } from '../format/status-values.js'

/** @typedef {'plain' | 'mono' | 'masked' | 'bootstrap'} AdvancedRowKind */
/** @typedef {{ kind: AdvancedRowKind, label: string, value: string, positive?: boolean, visibleSuffix?: number, items?: string[] }} AdvancedRow */
/** @typedef {{ key: string, title: string, rows: AdvancedRow[] }} AdvancedSection */

/** @param {boolean | null} value @param {TFunction} t @returns {string} */
function formatBool(value, t) {
  if (value === null) return DASH
  return value ? t('networkStatus.boolYes') : t('networkStatus.boolNo')
}

/** @param {NetworkStatusScreen} status @param {TFunction} t @returns {AdvancedRow} */
function portPreservationRow(status, t) {
  const preserved = status.address.publicPort > 0 && status.address.publicPort === status.address.localPort
  const value = preserved
    ? t('networkStatus.portPreservedYes')
    : status.dhtReady ? t('networkStatus.portPreservedNo') : DASH
  return { kind: 'plain', label: t('networkStatus.portPreserved'), value, positive: preserved }
}

/** @param {NetworkStatusScreen} status @param {number} now @param {TFunction} t @returns {AdvancedSection[]} */
export function advancedSections(status, now, t) {
  return [
    {
      key: 'connection',
      title: t('networkStatus.connection'),
      rows: [
        { kind: 'plain', label: t('networkStatus.peerCount'), value: formatNumber(status.peerCount) },
        { kind: 'plain', label: t('networkStatus.topicsJoined'), value: formatNumber(status.topics) },
        { kind: 'plain', label: t('networkStatus.lastConnected'), value: formatRelativeTime(status.lastConnectionAt, now) },
      ],
    },
    {
      key: 'address',
      title: t('networkStatus.address'),
      rows: [
        { kind: 'masked', label: t('networkStatus.publicHost'), value: status.address.publicHost ?? '' },
        { kind: 'mono', label: t('networkStatus.publicPort'), value: status.address.publicPort ? String(status.address.publicPort) : DASH },
        { kind: 'mono', label: t('networkStatus.localPort'), value: status.address.localPort ? String(status.address.localPort) : DASH },
        portPreservationRow(status, t),
        { kind: 'masked', label: t('networkStatus.publicKey'), value: status.identity.publicKey, visibleSuffix: 6 },
      ],
    },
    {
      key: 'nat',
      title: t('networkStatus.nat'),
      rows: [
        { kind: 'plain', label: t('networkStatus.firewalled'), value: formatBool(status.nat.firewalled, t) },
        { kind: 'plain', label: t('networkStatus.randomized'), value: formatBool(status.nat.randomized, t) },
        { kind: 'plain', label: t('networkStatus.ephemeral'), value: formatBool(status.nat.ephemeral, t) },
      ],
    },
    {
      key: 'relaying',
      title: t('networkStatus.relaying'),
      rows: [
        { kind: 'plain', label: t('networkStatus.relayedNow'), value: formatNumber(status.relay.connections.length) },
        { kind: 'plain', label: t('networkStatus.relayedSeen'), value: formatNumber(status.relay.seen) },
        { kind: 'plain', label: t('networkStatus.relayedActive'), value: formatNumber(status.stats.relaying.successes) },
        { kind: 'plain', label: t('networkStatus.relayedAttempts'), value: formatNumber(status.stats.relaying.attempts) },
        { kind: 'plain', label: t('networkStatus.relayedAborts'), value: formatNumber(status.stats.relaying.aborts) },
        { kind: 'plain', label: t('networkStatus.relaySelected'), value: formatNumber(status.stats.relaying.selected) },
      ],
    },
    {
      key: 'dht',
      title: t('networkStatus.dht'),
      rows: [
        { kind: 'plain', label: t('networkStatus.routingTableSize'), value: formatNumber(status.routing.tableSize) },
        { kind: 'mono', label: t('networkStatus.dhtVersion'), value: status.versions.dht },
        {
          kind: 'bootstrap',
          label: t('networkStatus.bootstrapNodes'),
          value: status.routing.bootstrap.length === 0 ? DASH : t('networkStatus.bootstrapEntries', { count: status.routing.bootstrap.length }),
          items: status.routing.bootstrap,
        },
      ],
    },
    {
      key: 'canary',
      title: t('networkStatus.canary'),
      rows: [
        { kind: 'plain', label: t('networkStatus.canaryState'), value: t(`networkStatus.summary.testValue.${status.canary.state}`) },
        { kind: 'plain', label: t('networkStatus.canaryRecords'), value: formatNumber(status.canary.stage1?.announceRecords) },
        { kind: 'plain', label: t('networkStatus.canaryChecked'), value: formatRelativeTime(status.canary.at || null, now) },
      ],
    },
  ]
}
