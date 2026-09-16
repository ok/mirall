// The Network Status section that lists which relay carries which people, grouped by relay.
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { relayGroups, peopleLabel, relayKindClasses, type RelayGroup } from '../../model/relay-groups.js'
import { formatDuration } from '../../model/connectivity.js'
import { getRelay } from '../../platform/config-client.js'
import Badge from '../primitives/Badge.js'
import { Section, Field, MaskedField } from './StatusRows.js'
import type { NetworkStatusScreen } from '../../types/types.js'

interface RelayedConnectionsSectionProps {
  status: NetworkStatusScreen
  now: number
}

export default function RelayedConnectionsSection({ status, now }: RelayedConnectionsSectionProps) {
  const { t } = useTranslation()
  const groups = relayGroups(status.relay.connections)
  if (groups.length === 0) return null
  return (
    <Section title={t('networkStatus.relayed.title')} intro={t('networkStatus.relayed.intro')}>
      {groups.map((group) => <RelayGroupRows key={group.key} group={group} now={now} />)}
    </Section>
  )
}

interface RelayGroupRowsProps {
  group: RelayGroup
  now: number
}

function RelayGroupRows({ group, now }: RelayGroupRowsProps) {
  const { t } = useTranslation()
  const badge = relayBadge(group, t)
  const single = group.people.length === 1 ? group.people[0] : null
  const since = single ? ` · ${t('networkStatus.relayed.since', { duration: formatDuration(now - single.since) })}` : ''
  return (
    <>
      <MaskedField
        label={t('networkStatus.relayed.relay')}
        value={group.relayKey}
        visibleSuffix={4}
        trailing={<Badge label={badge.label} classes={badge.classes} srLabel={badge.srLabel} />}
      />
      <Field label={t('networkStatus.relayed.people')} value={`${peopleLabel(group.people, t)}${since}`} />
    </>
  )
}

function relayBadge(group: RelayGroup, t: TFunction): { label: string; classes: string; srLabel: string } {
  if (group.via === 'own') {
    const kind = getRelay()?.kind ?? 'open'
    const label = t(`networkSettings.relays.kind.${kind}`)
    return { label, classes: relayKindClasses(kind), srLabel: t('networkStatus.relayed.badgeOwn', { kind: label }) }
  }
  const name = group.providerName ?? t('networkStatus.relayed.unknownPeer')
  return {
    label: t('networkStatus.relayed.providedBy', { name }),
    classes: 'bg-surface-container-highest text-on-surface-variant',
    srLabel: t('networkStatus.relayed.badgeAdopted', { name }),
  }
}
