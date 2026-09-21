import { useCallback, useState } from 'react'
import { useTranslation } from 'react-i18next'
import ConfirmDestructiveModal from '../../components/modals/ConfirmDestructiveModal.js'
import { request } from '../../ipc/ipc.js'
import { useQuery } from '../../store/useQuery.js'
import { refetchQuery, setQueryData } from '../../store/query-store.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import type { AuditConfig, AuditStats } from '../../types/types.js'
import PageHeader from '../../components/layout/PageHeader.js'
import ActionRow, { ROW_GROUP } from '../../components/layout/ActionRow.js'
import AuditRecordingCard from './AuditRecordingCard.js'
import SectionHeading from '../../components/layout/SectionHeading.js'
import Button from '../../components/primitives/Button.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useRunAction } from '../../hooks/useRunAction.js'

interface ActivityLogSettingsProps {
  onBack: () => void
  onOpenLog: () => void
}

export default function ActivityLogSettings({ onBack, onOpenLog }: ActivityLogSettingsProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const runAction = useRunAction()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  // The same two entries Account reads, scope-less for the reason stated there.
  const { data: config } = useQuery('audit:get-config', {}, null)
  const { data: stats } = useQuery('audit:stats', {}, null)
  const [busy, setBusy] = useState(false)
  const [status, setStatus] = useState<string | null>(null)
  const [confirmPurge, setConfirmPurge] = useState(false)

  const refresh = useCallback(async () => {
    await Promise.all([
      refetchQuery<AuditConfig>('audit:get-config', {}, null),
      refetchQuery<AuditStats>('audit:stats', {}, null),
    ])
  }, [])

  const patch = useCallback(async (next: Partial<AuditConfig>) => {
    // The worker answers with the record it applied, so push it rather than re-reading: a refetch
    // here would race the write it is meant to reflect.
    setQueryData<AuditConfig>('audit:get-config', {}, await request('audit:configure', next))
  }, [])

  const handleExport = useCallback(async () => {
    setBusy(true)
    setStatus(null)
    try {
      const payload = await request('audit:export', {}, 0)
      const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' })
      const url = URL.createObjectURL(blob)
      const link = document.createElement('a')
      link.href = url
      link.download = 'mirall-activity-log.json'
      link.click()
      URL.revokeObjectURL(url)
      setStatus(t('activityLogSettings.exportDone', { count: payload.entries.length }))
    } catch (err) {
      setStatus(errorText(err))
    } finally {
      setBusy(false)
    }
  }, [t, errorText])

  // The confirm closes only once the purge has succeeded; a rejection keeps it on its confirm step.
  // `busy` clears either way — it is what makes the dialog undismissable.
  const handlePurge = useCallback(() => {
    setBusy(true)
    runAction(async () => {
      try {
        const result = await request('audit:purge')
        setConfirmPurge(false)
        setStatus(t('activityLogSettings.deleteDone', { count: result.purged }))
      } finally {
        setBusy(false)
      }
      await refresh()
    })
  }, [refresh, runAction, t])

  return (
    <div
      ref={ref}
      className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}
    >
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('activityLogSettings.title')} subtitle={t('activityLogSettings.intro')} onBack={onBack} />

        <div className="space-y-10">
          <AuditRecordingCard config={config} onPatch={patch} />

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

          <section>
            <div className={ROW_GROUP}>
              <ActionRow
                icon="history"
                label={t('activityLogSettings.openLog')}
                desc={t('activityLogSettings.openLogSummary', { count: stats?.count ?? 0 })}
                onClick={onOpenLog}
              />
            </div>
          </section>
        </div>
      </div>

      <ConfirmDestructiveModal
        isOpen={confirmPurge}
        title={t('activityLogSettings.deleteConfirmTitle')}
        body={t('activityLogSettings.deleteConfirmBody')}
        confirmLabel={t('activityLogSettings.deleteAction')}
        busy={busy}
        onClose={() => setConfirmPurge(false)}
        onConfirm={handlePurge}
      />
    </div>
  )
}
