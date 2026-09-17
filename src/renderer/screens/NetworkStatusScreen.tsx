// Network diagnostics screen: connectivity verdict plus DHT/swarm details with maskable, copyable fields.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import type { TFunction } from 'i18next'
import { reachableState, formatDuration } from '../model/connectivity.js'
import { relayState, relayedPeopleCount } from '../model/relay-groups.js'
import { getRelayMode } from '../platform/config-client.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useConnectionStatus } from '../hooks/useConnectionStatus.js'
import Button from '../components/primitives/Button.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import RelayedConnectionsSection from '../components/network/RelayedConnectionsSection.js'
import { Section, Field } from '../components/network/StatusRows.js'
import { DASH, formatRelativeTime } from '../format/status-values.js'
import ActionRow, { ROW_GROUP } from '../components/layout/ActionRow.js'
import type { NetworkStatusScreen, Reachability } from '../types/types.js'

interface Props {
  onBack: () => void
  onShowHistory: () => void
  onOpenDiagnostics: () => void
  onOpenAdvanced: () => void
}

interface VerdictBannerProps {
  reachability: Reachability | null
  status: NetworkStatusScreen | null
  reconnecting: boolean
  reconnectThrottled: boolean
  onReconnect: () => void
}

function verdictLamp(verdict: string | undefined): string {
  if (verdict === 'blocked') return 'bg-error ring-error/25'
  if (verdict === 'at-risk') return 'bg-secondary-container ring-secondary-container/30'
  if (verdict === 'healthy') return 'bg-online ring-online/25'
  return 'bg-outline ring-outline/20'
}

function VerdictBanner({ reachability, status, reconnecting, reconnectThrottled, onReconnect }: VerdictBannerProps) {
  const { t } = useTranslation()
  const verdict = reachability?.verdict ?? 'unknown'
  const peerCount = status?.peerCount ?? 0
  const cause = reachability?.cause ?? 'generic'

  const headline = t(`networkStatus.verdict.${verdict}Title`)
  // "Nobody else is online right now" attributes the missing peers to the other side, so
  // it may only ever appear when we can actually reach the network.
  const subline = verdict === 'healthy'
    ? peerCount > 0
      ? t('networkStatus.verdict.healthyBodyPeers', { count: peerCount })
      : t('networkStatus.verdict.healthyBodyIdle')
    : t(`connectionProblem.body.${cause}`, { defaultValue: t(`networkStatus.verdict.${verdict}Body`) })

  return (
    <section>
      <div className="bg-surface-container-low rounded-xl p-6 flex items-center gap-5">
        <span aria-hidden="true" className={`w-4 h-4 rounded-full shrink-0 ring-4 ${verdictLamp(verdict)}`} />
        <div role="status" aria-live="polite" className="flex-1 min-w-0">
          <p className="text-2xl font-headline font-bold text-accent">{headline}</p>
          <p className="text-sm text-on-surface-variant mt-1">{subline}</p>
        </div>
        {verdict !== 'healthy' && verdict !== 'unknown' && (
          <button
            type="button"
            onClick={onReconnect}
            disabled={reconnecting || reconnectThrottled}
            aria-label={t('networkStatus.reconnect')}
            className="px-4 py-2 rounded-xl bg-primary text-on-primary font-semibold text-sm hover:bg-primary-hover active:scale-95 transition-all disabled:opacity-50 focus-ring"
          >
            {reconnecting ? t('networkStatus.reconnecting') : t('networkStatus.reconnect')}
          </button>
        )}
      </div>
    </section>
  )
}

// nat.firewalled initialises to true and reads true for nearly every home user, and
// nat.randomized is the same predicate as publicPort === 0 — so neither earns a line of
// its own. What is left is one statement per real finding.
function buildSuggestions(status: NetworkStatusScreen | null, browserOnline: boolean, t: (key: string) => string): string[] {
  const lines: string[] = []
  if (!status) return lines
  if (!browserOnline) {
    lines.push(t('networkStatus.advice.osOffline'))
    return lines
  }
  const reachable = reachableState(status)
  if (reachable === 'noAddress') lines.push(t('networkStatus.advice.noPublicAddr'))
  if (reachable === 'changingPorts') {
    lines.push(t('networkStatus.advice.symmetricNat'))
    lines.push(t('networkStatus.advice.symmetricNatFix'))
  }
  if (status.dhtHealth?.degraded) lines.push(t('networkStatus.advice.udpDegraded'))
  if (status.reachability?.verdict === 'unknown' && status.dhtReady) {
    lines.push(t('networkStatus.advice.stillSettling'))
  }
  return lines
}

interface SummaryProps {
  status: NetworkStatusScreen | null
  now: number
  onShowHistory: () => void
}

function ConnectionSummary({ status, now, onShowHistory }: SummaryProps) {
  const { t } = useTranslation()
  if (!status) return null
  const verdict = status.reachability?.verdict ?? 'unknown'
  const canary = status.canary?.state ?? 'unavailable'
  const canaryWhen = status.canary?.at ? formatRelativeTime(status.canary.at, now) : ''

  return (
    <Section title={t('networkStatus.summary.title')}>
      <Field label={t('networkStatus.summary.connection')} value={t(`networkStatus.summary.connectionValue.${verdict}`)} />
      <Field label={t('networkStatus.summary.reachable')} value={t(`networkStatus.summary.reachableValue.${reachableState(status)}`)} />
      <Field
        label={t('networkStatus.summary.connectionTest')}
        value={`${t(`networkStatus.summary.testValue.${canary}`)}${canaryWhen ? ` · ${canaryWhen}` : ''}`}
      />
      <Field
        label={t('networkStatus.summary.people')}
        value={t('networkStatus.summary.peopleValue', {
          found: status.peerReach?.discovered ?? 0,
          connected: status.peerReach?.connected ?? 0,
        })}
      />
      <Field label={t('networkStatus.summary.relay')} value={relaySummaryValue(status, t)} />
      <Field
        label={t('networkStatus.summary.runningFor')}
        value={status.bootedAt > 0 ? formatDuration(now - status.bootedAt) : DASH}
      />
      <div className="px-6 py-4 flex justify-center">
        <Button variant="secondary" onClick={onShowHistory} className="shrink-0">{t('networkStatus.connectionHistory')}</Button>
      </div>
    </Section>
  )
}

function relaySummaryValue(status: NetworkStatusScreen, t: TFunction): string {
  const state = relayState(getRelayMode(), status.relay)
  if (state !== 'used') return t(`networkStatus.summary.relayValue.${state}`)
  const relayed = relayedPeopleCount(status.relay)
  return t('networkStatus.summary.relayValue.used', { relayed, total: Math.max(relayed, status.peerReach.connected) })
}

function SuggestionsList({ lines }: { lines: string[] }) {
  const { t } = useTranslation()
  if (lines.length === 0) return null
  return (
    <section>
      <h2 className="text-xl font-headline font-bold text-accent mb-4">{t('networkStatus.advice.title')}</h2>
      <ul className="bg-surface-container-low rounded-xl p-6 space-y-3 text-sm text-on-surface">
        {lines.map((line) => (
          <li key={line} className="flex items-start gap-3">
            <Icon name="tips_and_updates" className="text-tertiary-fixed shrink-0" />
            <span>{line}</span>
          </li>
        ))}
      </ul>
    </section>
  )
}

export default function NetworkStatusScreen({ onBack, onShowHistory, onOpenDiagnostics, onOpenAdvanced }: Props) {
  const { t } = useTranslation()
  const { status, reachability, reconnect } = useConnectionStatus()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectThrottled, setReconnectThrottled] = useState(false)
  const browserOnline = typeof navigator !== 'undefined' ? navigator.onLine : true
  const now = Date.now()

  async function handleReconnect() {
    if (reconnecting) return
    setReconnecting(true)
    try {
      await reconnect()
    } finally {
      setReconnecting(false)
      setReconnectThrottled(true)
      setTimeout(() => setReconnectThrottled(false), 5000)
    }
  }

  const suggestions = buildSuggestions(status, browserOnline, t)

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader
          title={t('networkStatus.title')}
          subtitle={t('networkStatus.intro')}
          onBack={onBack}
        />

        <div className="space-y-8">
          <VerdictBanner
            reachability={reachability}
            status={status}
            reconnecting={reconnecting}
            reconnectThrottled={reconnectThrottled}
            onReconnect={handleReconnect}
          />

          <SuggestionsList lines={suggestions} />

          <ConnectionSummary status={status} now={now} onShowHistory={onShowHistory} />

          {status && <RelayedConnectionsSection status={status} now={now} />}

          <section>
            <h2 className="text-xl font-headline font-bold text-accent mb-4">{t('networkStatus.troubleshooting')}</h2>
            <div className={ROW_GROUP}>
              <ActionRow
                icon="description"
                label={t('diagnostics.title')}
                desc={t('diagnostics.rowDesc')}
                onClick={onOpenDiagnostics}
              />
              <ActionRow
                icon="tune"
                label={t('networkStatus.advanced.title')}
                desc={t('networkStatus.advancedHint')}
                onClick={onOpenAdvanced}
              />
            </div>
          </section>
        </div>
      </div>

    </div>
  )
}
