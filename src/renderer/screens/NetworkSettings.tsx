// Network settings: content-plane transfer caps. Settings only — live connection status
// lives on the account screen.
import { useState, useEffect, useCallback, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc.js'
import { formatSpeed } from '../utils.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import RelaySettingsSection from '../components/settings/RelaySettingsSection.js'
import { isRelayFeatureEnabled } from '../config-client.js'
import type { BandwidthLimits } from '../global.js'

interface NetworkSettingsProps {
  onBack: () => void
}

type Direction = 'download' | 'upload'

// Below this a single chunk can outlive the transfer watchdog; the worker clamps to the
// same floor (bandwidth-limiter.js).
const MIN_KBPS = 32
const PRESET_KBPS = [0, 1024, 5120, 25600]
const COMMIT_DEBOUNCE_MS = 400

const SEGMENT_BASE =
  'flex items-center px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30'
const SEGMENT_ON = 'bg-surface-container-lowest shadow-sm text-accent font-semibold'
const SEGMENT_OFF = 'text-on-surface-variant hover:text-accent font-medium'

function LimitRow({
  direction,
  kbps,
  custom,
  onPreset,
  onCustom,
  onValue,
}: {
  direction: Direction
  kbps: number
  custom: boolean
  onPreset: (next: number) => void
  onCustom: () => void
  onValue: (next: number) => void
}) {
  const { t } = useTranslation()
  const inputId = `${direction}-limit`
  const helpId = `${direction}-limit-help`
  // The field is a draft until it settles: persisting per keystroke would push "1", then
  // "12", then "120" to the worker, and each write is an IPC round-trip.
  const [draft, setDraft] = useState(String(kbps))
  useEffect(() => { setDraft(String(kbps)) }, [kbps])
  const parsed = Math.max(0, Math.floor(Number(draft) || 0))
  const belowFloor = parsed > 0 && parsed < MIN_KBPS

  const latest = useRef({ parsed, kbps, onValue })
  latest.current = { parsed, kbps, onValue }
  const commit = useCallback(() => {
    const now = latest.current
    if (now.parsed !== now.kbps) now.onValue(now.parsed)
  }, [])

  useEffect(() => {
    if (!custom) return undefined
    const id = setTimeout(commit, COMMIT_DEBOUNCE_MS)
    return () => clearTimeout(id)
  }, [draft, custom, commit])

  // Navigating away must not silently discard what was typed — a click that never blurs
  // the field (or a keyboard-driven back) would otherwise lose it.
  useEffect(() => () => commit(), [commit])

  return (
    <div>
      <div className="flex items-center justify-between gap-4">
        <p className="font-semibold text-accent">{t(`networkSettings.${direction}`)}</p>
        <div className="flex bg-surface-container-high dark:bg-surface-container-highest p-1 rounded-full shrink-0">
          {PRESET_KBPS.map((preset) => {
            const label = preset === 0 ? t('networkSettings.unlimited') : `${preset / 1024} MB/s`
            const active = !custom && kbps === preset
            return (
              <button
                key={preset}
                type="button"
                onClick={() => onPreset(preset)}
                aria-label={t(`networkSettings.a11y.${direction}Preset`, { rate: label })}
                aria-pressed={active}
                className={`${SEGMENT_BASE} ${active ? SEGMENT_ON : SEGMENT_OFF}`}
              >
                {label}
              </button>
            )
          })}
          <button
            type="button"
            onClick={onCustom}
            aria-label={t(`networkSettings.a11y.${direction}Custom`)}
            aria-pressed={custom}
            className={`${SEGMENT_BASE} ${custom ? SEGMENT_ON : SEGMENT_OFF}`}
          >
            {t('networkSettings.custom')}
          </button>
        </div>
      </div>

      {custom && (
        <div className="mt-4 space-y-2">
          <label htmlFor={inputId} className="font-headline text-sm font-bold text-accent px-1 block">
            {t(`networkSettings.${direction}CustomLabel`)}
          </label>
          <input
            id={inputId}
            type="number"
            inputMode="numeric"
            min={0}
            step={1}
            value={draft}
            aria-describedby={helpId}
            onChange={(e) => setDraft(e.target.value)}
            onBlur={commit}
            onKeyDown={(e) => { if (e.key === 'Enter') commit() }}
            className="w-full bg-surface-container-lowest border-none rounded-xl px-4 py-4 text-on-surface focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 transition-all text-lg tabular-nums"
          />
          {belowFloor ? (
            <div id={helpId} role="status" className="rounded-xl bg-warning px-5 py-3 text-sm font-medium text-on-warning">
              {t('networkSettings.floorAdvisory', { min: MIN_KBPS })}
            </div>
          ) : (
            <p id={helpId} className="text-xs text-on-surface-variant px-1">
              {parsed > 0
                ? t('networkSettings.customEcho', { rate: formatSpeed(parsed * 1024) })
                : t('networkSettings.customUnlimited')}
            </p>
          )}
        </div>
      )}
    </div>
  )
}

export default function NetworkSettings({ onBack }: NetworkSettingsProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [limits, setLimits] = useState<BandwidthLimits>({ downloadKBps: 0, uploadKBps: 0 })
  // Which rows show the number input. Derived from the stored value on load, then owned by
  // the user: picking Custom must not discard the cap they already have.
  const [custom, setCustom] = useState<Record<Direction, boolean>>({ download: false, upload: false })

  useEffect(() => {
    let cancelled = false
    window.bridge.getBandwidth()
      .then((stored) => {
        if (cancelled) return
        setLimits(stored)
        setCustom({
          download: !PRESET_KBPS.includes(stored.downloadKBps),
          upload: !PRESET_KBPS.includes(stored.uploadKBps),
        })
      })
      .catch(() => {})
    return () => { cancelled = true }
  }, [])

  const apply = useCallback(async (next: BandwidthLimits) => {
    setLimits(next)
    try {
      const persisted = await window.bridge.setBandwidth(next)
      await request('settings:set-bandwidth', { ...persisted })
    } catch {
      // A failed write leaves the worker on its previous cap; the next change retries.
    }
  }, [])

  const rowProps = (direction: Direction) => {
    const key = direction === 'download' ? 'downloadKBps' : 'uploadKBps'
    return {
      direction,
      kbps: limits[key],
      custom: custom[direction],
      onPreset: (next: number) => {
        setCustom((prev) => ({ ...prev, [direction]: false }))
        apply({ ...limits, [key]: next })
      },
      onCustom: () => setCustom((prev) => ({ ...prev, [direction]: true })),
      onValue: (next: number) => apply({ ...limits, [key]: next }),
    }
  }

  return (
    <div
      ref={ref}
      className={`h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('networkSettings.title')} subtitle={t('networkSettings.intro')} onBack={onBack} />

        <div className="space-y-10">
          <section>
            <SectionHeading>{t('networkSettings.transferLimits')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl p-6 space-y-6">
              <LimitRow {...rowProps('download')} />
              <LimitRow {...rowProps('upload')} />
              <p className="text-sm text-on-surface-variant leading-relaxed pt-1">
                {t('networkSettings.scopeNote')}
              </p>
            </div>
          </section>

          {isRelayFeatureEnabled() && <RelaySettingsSection />}
        </div>
      </div>
    </div>
  )
}
