// Network diagnostics screen: connectivity verdict plus DHT/swarm details with maskable, copyable fields.
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isRelayFeatureEnabled } from '../config-client.js'
import { reachableState, formatDuration } from '../connectivity.js'
import DiagnosticsCard from '../components/settings/DiagnosticsCard.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useConnectionStatus } from '../hooks/useConnectionStatus.js'
import Button from '../components/primitives/Button.js'
import CopyButton from '../components/primitives/CopyButton.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import type { NetworkStatus, Reachability } from '../types.js'

interface Props {
  onBack: () => void
  onShowHistory: () => void
}

const DASH = '—'
const REVEAL_AUTO_HIDE_MS = 30000

function formatRelativeTime(ms: number | null, now: number): string {
  if (ms === null) return DASH
  const delta = Math.max(0, now - ms)
  const seconds = Math.floor(delta / 1000)
  if (seconds < 60) return `${seconds}s ago`
  const minutes = Math.floor(seconds / 60)
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  const days = Math.floor(hours / 24)
  return `${days}d ago`
}

function formatBool(value: boolean | null, t: (key: string) => string): string {
  if (value === null) return DASH
  return value ? t('networkStatus.boolYes') : t('networkStatus.boolNo')
}

function formatNumber(value: number | null | undefined): string {
  if (value === null || value === undefined) return DASH
  return value.toLocaleString()
}

function maskValue(value: string | null, visibleSuffix: number = 0): string {
  if (!value) return DASH
  const dots = '••••••••'
  if (visibleSuffix > 0 && value.length > visibleSuffix) {
    return `${dots} ${value.slice(-visibleSuffix)}`
  }
  return dots
}

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section>
      <h2 className="text-xl font-headline font-bold text-accent mb-4">{title}</h2>
      <div className="bg-surface-container-low rounded-xl divide-y divide-surface-container-high/30">
        {children}
      </div>
    </section>
  )
}

interface FieldProps {
  label: string
  value: ReactNode
  mono?: boolean
  copyValue?: string | null
  positive?: boolean
}

function Field({ label, value, mono = false, copyValue = null, positive = false }: FieldProps) {
  const display = value === '' || value === undefined || value === null ? DASH : value
  return (
    <div className="px-6 py-4 flex items-center gap-4">
      <span className="text-sm text-on-surface-variant w-48 shrink-0">{label}</span>
      <span className={`flex-1 min-w-0 break-all ${mono ? 'font-mono text-sm' : 'text-sm'} ${positive ? 'text-online' : 'text-accent'}`}>
        {display}
      </span>
      {copyValue && copyValue.length > 0 && (
        <CopyButton value={copyValue} />
      )}
    </div>
  )
}

interface MaskedFieldProps {
  label: string
  value: string | null
  visibleSuffix?: number
}

function MaskedField({ label, value, visibleSuffix = 0 }: MaskedFieldProps) {
  const { t } = useTranslation()
  const [revealed, setRevealed] = useState(false)
  const hasValue = !!value && value.length > 0

  useEffect(() => {
    if (!revealed) return
    const timer = setTimeout(() => setRevealed(false), REVEAL_AUTO_HIDE_MS)
    return () => clearTimeout(timer)
  }, [revealed])

  const display = revealed && value ? value : maskValue(value, visibleSuffix)
  const toggleLabel = revealed ? t('networkStatus.hide') : t('networkStatus.reveal')

  return (
    <div className="px-6 py-4 flex items-center gap-4">
      <span className="text-sm text-on-surface-variant w-48 shrink-0">{label}</span>
      <span className="flex-1 min-w-0 font-mono text-sm text-accent break-all">{display}</span>
      {hasValue && <CopyButton value={value} />}
      {hasValue && (
        <button
          type="button"
          onClick={() => setRevealed((v) => !v)}
          aria-label={toggleLabel}
          title={toggleLabel}
          className="shrink-0 inline-flex items-center justify-center rounded-sm focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
        >
          <Icon name={revealed ? 'visibility_off' : 'visibility'} size={18} className="text-outline" />
        </button>
      )}
    </div>
  )
}

interface BootstrapListProps {
  items: string[]
  emptyLabel: string
  countLabel: (n: number) => string
}

function BootstrapList({ items, emptyLabel, countLabel }: BootstrapListProps) {
  const [open, setOpen] = useState(false)
  if (items.length === 0) {
    return <div className="px-6 py-4 text-sm text-on-surface-variant">{emptyLabel}</div>
  }
  return (
    <div className="px-6 py-4">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        aria-expanded={open}
        className="text-sm font-medium text-accent flex items-center gap-2 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 rounded-sm"
      >
        <Icon name={open ? 'expand_more' : 'chevron_right'} size={18} className="text-outline" />
        {countLabel(items.length)}
      </button>
      {open && (
        <ul className="mt-3 space-y-1 font-mono text-xs text-on-surface-variant">
          {items.map((entry) => (
            <li key={entry} className="break-all">{entry}</li>
          ))}
        </ul>
      )}
    </div>
  )
}

interface VerdictBannerProps {
  reachability: Reachability | null
  status: NetworkStatus | null
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
        {verdict !== 'healthy' && (
          <button
            type="button"
            onClick={onReconnect}
            disabled={reconnecting || reconnectThrottled}
            aria-label={t('networkStatus.reconnect')}
            className="px-4 py-2 rounded-xl bg-primary text-on-primary font-semibold text-sm hover:opacity-90 active:scale-95 transition-all disabled:opacity-50 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
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
function buildSuggestions(status: NetworkStatus | null, browserOnline: boolean, t: (key: string) => string): string[] {
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
  status: NetworkStatus | null
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
      <Field
        label={t('networkStatus.summary.runningFor')}
        value={status.bootedAt > 0 ? formatDuration(now - status.bootedAt) : DASH}
      />
      <div className="pt-3">
        <Button variant="secondary" onClick={onShowHistory}>{t('networkStatus.connectionHistory')}</Button>
      </div>
    </Section>
  )
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

interface AdvancedDetailsProps {
  status: NetworkStatus | null
  relayVisible: boolean
  now: number
}

function AdvancedDetails({ status, relayVisible, now }: AdvancedDetailsProps) {
  const { t } = useTranslation()
  if (!status) return null
  const portPreserved = status.address.publicPort > 0
    && status.address.publicPort === status.address.localPort
  const portPreservationLabel = portPreserved
    ? t('networkStatus.portPreservedYes')
    : status.dhtReady ? t('networkStatus.portPreservedNo') : DASH

  return (
    <>
              <Section title={t('networkStatus.connection')}>
                <Field label={t('networkStatus.peerCount')}     value={formatNumber(status.peerCount)} />
                <Field label={t('networkStatus.topicsJoined')}  value={formatNumber(status.topics)} />
                <Field label={t('networkStatus.lastConnected')} value={formatRelativeTime(status.lastConnectionAt, now)} />
              </Section>

              <Section title={t('networkStatus.address')}>
                <MaskedField label={t('networkStatus.publicHost')} value={status.address.publicHost} />
                <Field label={t('networkStatus.publicPort')} value={status.address.publicPort ? String(status.address.publicPort) : DASH} mono />
                <Field label={t('networkStatus.localPort')}  value={status.address.localPort ? String(status.address.localPort) : DASH} mono />
                <Field
                  label={t('networkStatus.portPreserved')}
                  value={portPreservationLabel}
                  positive={portPreserved}
                />
                <MaskedField label={t('networkStatus.publicKey')} value={status.identity.publicKey} visibleSuffix={6} />
              </Section>

              <Section title={t('networkStatus.nat')}>
                <Field label={t('networkStatus.firewalled')} value={formatBool(status.nat.firewalled, t)} />
                <Field label={t('networkStatus.randomized')} value={formatBool(status.nat.randomized, t)} />
                <Field label={t('networkStatus.ephemeral')}  value={formatBool(status.nat.ephemeral, t)} />
              </Section>

              {relayVisible && (
                <Section title={t('networkStatus.relaying')}>
                  <Field label={t('networkStatus.relayedActive')}   value={formatNumber(status.stats.relaying.successes)} />
                  <Field label={t('networkStatus.relayedAttempts')} value={formatNumber(status.stats.relaying.attempts)} />
                  <Field label={t('networkStatus.relayedAborts')}   value={formatNumber(status.stats.relaying.aborts)} />
                </Section>
              )}

              <Section title={t('networkStatus.dht')}>
                <Field label={t('networkStatus.routingTableSize')} value={formatNumber(status.routing.tableSize)} />
                <Field label={t('networkStatus.dhtVersion')}        value={status.versions.dht} mono />
                <BootstrapList
                  items={status.routing.bootstrap}
                  emptyLabel={DASH}
                  countLabel={(n) => t('networkStatus.bootstrapEntries', { count: n })}
                />
              </Section>

              <Section title={t('networkStatus.canary')}>
                <Field label={t('networkStatus.canaryState')} value={t(`networkStatus.summary.testValue.${status.canary.state}`)} />
                <Field label={t('networkStatus.canaryRecords')} value={formatNumber(status.canary.stage1?.announceRecords)} />
                <Field label={t('networkStatus.canaryChecked')} value={formatRelativeTime(status.canary.at || null, now)} />
              </Section>
    </>
  )
}

export default function NetworkStatusScreen({ onBack, onShowHistory }: Props) {
  const { t } = useTranslation()
  const { status, reachability, reconnect } = useConnectionStatus()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [reconnecting, setReconnecting] = useState(false)
  const [reconnectThrottled, setReconnectThrottled] = useState(false)
  const [advancedOpen, setAdvancedOpen] = useState(false)
  const relayVisible = isRelayFeatureEnabled()
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
      className={`h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
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

          <DiagnosticsCard />

          <section>
            <button
              type="button"
              onClick={() => setAdvancedOpen((v) => !v)}
              aria-expanded={advancedOpen}
              className="w-full bg-surface-container-low rounded-xl p-4 flex items-center gap-3 text-left hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
            >
              <Icon name={advancedOpen ? 'expand_more' : 'chevron_right'} className="text-outline" />
              <span className="font-medium text-accent">{t('networkStatus.advancedToggle')}</span>
              <span className="ml-auto text-xs text-on-surface-variant">{t('networkStatus.advancedHint')}</span>
            </button>
          </section>

          {advancedOpen && <AdvancedDetails status={status} relayVisible={relayVisible} now={now} />}
        </div>
      </div>

    </div>
  )
}
