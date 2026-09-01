import { useCallback, useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { RETENTION_CHOICES } from '../auditRetentionChoices.js'
import type { AuditConfig, AuditEntry, AuditStats } from '../types.js'
import Icon from '../components/primitives/Icon.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import Modal from '../components/primitives/Modal.js'
import Button from '../components/primitives/Button.js'
import IconButton from '../components/primitives/IconButton.js'

interface ActivityLogSettingsProps {
  onBack: () => void
  onOpenLog: () => void
}

interface AuditExport {
  version: number
  exportedAt: number
  entries: AuditEntry[]
}

export default function ActivityLogSettings({ onBack, onOpenLog }: ActivityLogSettingsProps) {
  const { t } = useTranslation()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [config, setConfig] = useState<AuditConfig | null>(null)
  const [stats, setStats] = useState<AuditStats | null>(null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [confirmPurge, setConfirmPurge] = useState(false)

  const refresh = useCallback(async () => {
    const [nextConfig, nextStats] = await Promise.all([
      request('audit:get-config') as Promise<AuditConfig>,
      request('audit:stats') as Promise<AuditStats>,
    ])
    setConfig(nextConfig)
    setStats(nextStats)
  }, [])

  useEffect(() => { void refresh() }, [refresh])

  const patch = useCallback(async (next: Partial<AuditConfig>) => {
    const applied = await request('audit:configure', next) as AuditConfig
    setConfig(applied)
  }, [])

  const handleExport = useCallback(async () => {
    setBusy(true)
    setStatus(null)
    try {
      const payload = await request('audit:export', {}, 0) as AuditExport
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'mirall-activity-log.json'
      link.click()
      URL.revokeObjectURL(url)
      setStatus(t('activityLogSettings.exportDone', { count: payload.entries.length }))
    } catch (err) {
      setStatus(err instanceof Error ? err.message : String(err))
    } finally {
      setBusy(false)
    }
  }, [t])

  const handlePurge = useCallback(async () => {
    setBusy(true)
    try {
      const result = await request('audit:purge') as { purged: number }
      setStatus(t('activityLogSettings.deleteDone', { count: result.purged }))
      await refresh()
    } finally {
      setBusy(false)
      setConfirmPurge(false)
    }
  }, [refresh, t])

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('activityLogSettings.title')} subtitle={t('activityLogSettings.intro')} onBack={onBack} />

        <div className="space-y-10">
          <section>
            <button
              type="button"
              onClick={onOpenLog}
              aria-label={t('activityLogSettings.openLog')}
              className="w-full bg-surface-container-low rounded-xl p-6 flex items-center gap-4 text-left hover:bg-surface-container-high/50 active:scale-[0.99] transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 cursor-pointer"
            >
              <div className="w-10 h-10 rounded-full bg-icon-tile flex items-center justify-center text-on-icon-tile shrink-0">
                <Icon name="history" />
              </div>
              <div className="flex-1 min-w-0">
                <p className="font-semibold text-accent">{t('activityLogSettings.openLog')}</p>
                <p className="text-xs text-on-surface-variant">
                  {t('activityLogSettings.openLogSummary', { count: stats?.count ?? 0 })}
                </p>
              </div>
              <Icon name="chevron_right" className="text-secondary" />
            </button>
          </section>

          <section>
            <SectionHeading>{t('activityLogSettings.recording')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl overflow-hidden">
              <div className="w-full p-6 flex items-center justify-between hover:bg-surface-container-high/50 transition-colors">
                <div className="pr-6">
                  <p className="font-semibold text-accent">{t('activityLogSettings.recordActivity')}</p>
                  <p className="text-xs text-on-surface-variant mt-0.5">{t('activityLogSettings.recordActivityDesc')}</p>
                </div>
                <button
                  type="button"
                  role="switch"
                  aria-checked={config?.enabled ?? false}
                  aria-label={t('activityLogSettings.recordActivity')}
                  onClick={() => void patch({ enabled: !(config?.enabled ?? false) })}
                  className={`relative shrink-0 w-12 h-7 rounded-full transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                    config?.enabled ? 'bg-primary' : 'bg-surface-container-high'
                  }`}
                >
                  <span
                    className={`absolute top-1 left-1 w-5 h-5 rounded-full bg-surface-container-lowest transition-transform ${
                      config?.enabled ? 'translate-x-5' : ''
                    }`}
                  />
                </button>
              </div>

              <div className="px-6 py-5 border-t border-outline-variant/40 flex items-center justify-between gap-4">
                <div>
                  <p className="font-semibold text-accent">{t('activityLogSettings.retention')}</p>
                  <p className="text-xs text-on-surface-variant mt-0.5">{t('activityLogSettings.retentionDesc')}</p>
                </div>
                <div className="flex bg-surface-container-high dark:bg-surface-container-highest p-1 rounded-full shrink-0">
                  {RETENTION_CHOICES.map((days) => {
                    const on = config?.retentionDays === days
                    return (
                      <button
                        key={days}
                        type="button"
                        aria-pressed={on}
                        onClick={() => void patch({ retentionDays: days })}
                        className={`px-4 py-2 rounded-full text-sm transition-all active:scale-95 focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30 ${
                          on ? 'bg-surface-container-lowest shadow-sm text-accent font-semibold' : 'text-on-surface-variant hover:text-accent font-medium'
                        }`}
                      >
                        {t('activityLogSettings.retentionDays', { count: days })}
                      </button>
                    )
                  })}
                </div>
              </div>
            </div>
            <p className="mt-3 text-xs text-on-surface-variant">{t('activityLogSettings.survivesLeave')}</p>
          </section>

          <section>
            <SectionHeading>{t('activityLogSettings.export')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl p-6 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-semibold text-accent">{t('activityLogSettings.exportTitle')}</p>
                <p className="text-xs text-on-surface-variant mt-0.5">{t('activityLogSettings.exportDesc')}</p>
              </div>
              <Button variant="secondary" onClick={() => void handleExport()} disabled={busy} className="shrink-0">
                {t('activityLogSettings.exportAction')}
              </Button>
            </div>
            {status && <p role="status" aria-live="polite" className="mt-3 text-xs text-on-surface-variant">{status}</p>}
          </section>

          <section>
            <SectionHeading>{t('activityLogSettings.delete')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl p-6 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-semibold text-accent">{t('activityLogSettings.deleteTitle')}</p>
                <p className="text-xs text-on-surface-variant mt-0.5">{t('activityLogSettings.deleteDesc')}</p>
              </div>
              <Button variant="danger" onClick={() => setConfirmPurge(true)} disabled={busy}>
                {t('activityLogSettings.deleteAction')}
              </Button>
            </div>
          </section>
        </div>
      </div>

      <Modal
        isOpen={confirmPurge}
        onClose={busy ? () => undefined : () => setConfirmPurge(false)}
        ariaLabel={t('activityLogSettings.deleteConfirmTitle')}
        panelClassName="glass-modal w-full max-w-md rounded-3xl shadow-2xl shadow-black/30 overflow-hidden relative"
      >
        <div className="px-10 pt-10 pb-6">
          <div className="flex justify-between items-start mb-2 gap-3">
            <h2 className="text-2xl font-headline font-extrabold text-accent tracking-tight">
              {t('activityLogSettings.deleteConfirmTitle')}
            </h2>
            <IconButton
              icon="close"
              onClick={() => setConfirmPurge(false)}
              ariaLabel={t('actions.close')}
              disabled={busy}
              iconClassName="text-secondary"
            />
          </div>
        </div>
        <div className="px-10 pb-10 space-y-6">
          <p className="text-on-surface-variant font-medium">{t('activityLogSettings.deleteConfirmBody')}</p>
          <div className="flex gap-3">
            <Button variant="secondary" size="lg" className="flex-1" onClick={() => setConfirmPurge(false)} disabled={busy}>
              {t('actions.cancel')}
            </Button>
            <Button variant="danger" size="lg" className="flex-1" onClick={() => void handlePurge()} disabled={busy}>
              {t('activityLogSettings.deleteAction')}
            </Button>
          </div>
        </div>
      </Modal>
    </div>
  )
}
