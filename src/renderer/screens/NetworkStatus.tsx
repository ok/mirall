// Network diagnostics screen: connectivity verdict plus DHT/swarm details with maskable, copyable fields.
import { useEffect, useState, type ReactNode } from 'react'
import { useTranslation } from 'react-i18next'
import { isRelayFeatureEnabled } from '../config-client.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useConnectionStatus } from '../hooks/useConnectionStatus.js'
import NetworkStatusIndicator from '../components/widgets/NetworkStatusIndicator.js'
import CopyButton from '../components/primitives/CopyButton.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import type { NetworkStatus, ConnectivityState } from '../types.js'

interface Props {
  onBack: () => void
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
  state: ConnectivityState
  status: NetworkStatus | null
  reconnecting: boolean
  reconnectThrottled: boolean
  onReconnect: () => void
}

function VerdictBanner({ state, status, reconnecting, reconnectThrottled, onReconnect }: VerdictBannerProps) {
  const { t } = useTranslation()
  const peerCount = status?.peerCount ?? 0
  const headline = state === 'online'
    ? t('networkStatus.verdict.healthyTitle')
    : state === 'connecting'
      ? t('networkStatus.verdict.connectingTitle')
      : t('networkStatus.verdict.offlineTitle')
  const subline = state === 'online'
    ? peerCount > 0
      ? t('networkStatus.verdict.healthyBodyPeers', { count: peerCount })
      : t('networkStatus.verdict.healthyBodyIdle')
    : state === 'connecting'
      ? t('networkStatus.verdict.connectingBody')
      : t('networkStatus.verdict.offlineBody')

  return (
    <section>
      <div className="bg-surface-container-low rounded-xl p-6 flex items-center gap-5">
        <NetworkStatusIndicator state={state} size="lg" />
        <div role="status" aria-live="polite" className="flex-1 min-w-0">
          <p className="text-2xl font-headline font-bold text-accent">{headline}</p>
          <p className="text-sm text-on-surface-variant mt-1">{subline}</p>
        </div>
        {state !== 'online' && (
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

function buildEssentialSuggestions(status: NetworkStatus | null, state: ConnectivityState, browserOnline: boolean, t: (key: string) => string): string[] {
  const lines: string[] = []
  if (state === 'offline' && !browserOnline) lines.push(t('networkStatus.advice.osOffline'))
  if (status && state !== 'offline' && status.dhtReady && status.address.publicHost === null) {
    lines.push(t('networkStatus.advice.noPublicAddr'))
  }
  if (status && status.nat.ephemeral === true && status.peerCount === 0 && state === 'connecting') {
    lines.push(t('networkStatus.advice.stillBootstrapping'))
  }
  if (status && state !== 'offline' && status.routing.tableSize > 0 && status.routing.tableSize < 5 && status.peerCount === 0) {
    lines.push(t('networkStatus.advice.smallRoutingTable'))
  }
  return lines
}

function buildAdvancedSuggestions(status: NetworkStatus | null, t: (key: string) => string): string[] {
  const lines: string[] = []
  if (!status) return lines
  if (status.nat.firewalled === true) lines.push(t('networkStatus.advice.firewalled'))
  if (status.nat.randomized === true) lines.push(t('networkStatus.advice.randomizedNat'))
  if (status.dhtReady && status.address.publicPort === 0) lines.push(t('networkStatus.advice.symmetricNat'))
  return lines
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

export default function NetworkStatusScreen({ onBack }: Props) {
  const { t } = useTranslation()
  const { state, status, reconnect } = useConnectionStatus()
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

  const essentialSuggestions = buildEssentialSuggestions(status, state, browserOnline, t)
  const advancedSuggestions = buildAdvancedSuggestions(status, t)
  const portPreserved = !!status && status.address.publicPort > 0
    && status.address.publicPort === status.address.localPort
  const portPreservationLabel = portPreserved
    ? t('networkStatus.portPreservedYes')
    : status && status.dhtReady ? t('networkStatus.portPreservedNo') : DASH

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
            state={state}
            status={status}
            reconnecting={reconnecting}
            reconnectThrottled={reconnectThrottled}
            onReconnect={handleReconnect}
          />

          <SuggestionsList lines={essentialSuggestions} />

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

          {advancedOpen && (
            <>
              <Section title={t('networkStatus.connection')}>
                <Field label={t('networkStatus.peerCount')}     value={formatNumber(status?.peerCount)} />
                <Field label={t('networkStatus.topicsJoined')}  value={formatNumber(status?.topics)} />
                <Field label={t('networkStatus.lastConnected')} value={formatRelativeTime(status?.lastConnectionAt ?? null, now)} />
              </Section>

              <Section title={t('networkStatus.address')}>
                <MaskedField label={t('networkStatus.publicHost')} value={status?.address.publicHost ?? null} />
                <Field label={t('networkStatus.publicPort')} value={status?.address.publicPort ? String(status.address.publicPort) : DASH} mono />
                <Field label={t('networkStatus.localPort')}  value={status?.address.localPort ? String(status.address.localPort) : DASH} mono />
                <Field
                  label={t('networkStatus.portPreserved')}
                  value={portPreservationLabel}
                  positive={portPreserved}
                />
                <MaskedField label={t('networkStatus.publicKey')} value={status?.identity.publicKey ?? null} visibleSuffix={6} />
              </Section>

              <Section title={t('networkStatus.nat')}>
                <Field label={t('networkStatus.firewalled')} value={formatBool(status?.nat.firewalled ?? null, t)} />
                <Field label={t('networkStatus.randomized')} value={formatBool(status?.nat.randomized ?? null, t)} />
                <Field label={t('networkStatus.ephemeral')}  value={formatBool(status?.nat.ephemeral ?? null, t)} />
              </Section>

              {relayVisible && (
                <Section title={t('networkStatus.relaying')}>
                  <Field label={t('networkStatus.relayedActive')}   value={formatNumber(status?.stats.relaying.successes)} />
                  <Field label={t('networkStatus.relayedAttempts')} value={formatNumber(status?.stats.relaying.attempts)} />
                  <Field label={t('networkStatus.relayedAborts')}   value={formatNumber(status?.stats.relaying.aborts)} />
                </Section>
              )}

              <Section title={t('networkStatus.dht')}>
                <Field label={t('networkStatus.routingTableSize')} value={formatNumber(status?.routing.tableSize)} />
                <Field label={t('networkStatus.dhtVersion')}        value={status?.versions.dht ?? DASH} mono />
                <BootstrapList
                  items={status?.routing.bootstrap ?? []}
                  emptyLabel={DASH}
                  countLabel={(n) => t('networkStatus.bootstrapEntries', { count: n })}
                />
              </Section>

              <SuggestionsList lines={advancedSuggestions} />
            </>
          )}
        </div>
      </div>
    </div>
  )
}
