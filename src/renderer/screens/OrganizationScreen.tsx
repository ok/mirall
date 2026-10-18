// The organization that manages this install: who it is, how to reach it, and leaving it. Reached
// from About only while the install is managed; with no organization it returns to About at once.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { useManaged } from '../hooks/useManaged.js'
import { useHasVerticalOverflow } from '../hooks/useHasVerticalOverflow.js'
import { useErrorText } from '../hooks/useErrorText.js'
import { useRunAction } from '../hooks/useRunAction.js'
import { useToast } from '../components/toast/ToastProvider.js'
import { formatDateTime } from '../format/utils.js'
import PageHeader from '../components/layout/PageHeader.js'
import SectionHeading from '../components/layout/SectionHeading.js'
import { LinkRow, ROW_GROUP, Tile } from '../components/layout/ActionRow.js'
import Button from '../components/primitives/Button.js'
import Callout from '../components/primitives/Callout.js'
import InlineError from '../components/primitives/InlineError.js'
import ConfirmDestructiveModal from '../components/modals/ConfirmDestructiveModal.js'

interface OrganizationScreenProps {
  onBack: () => void
}

export default function OrganizationScreen({ onBack }: OrganizationScreenProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()
  const runAction = useRunAction()
  const managed = useManaged()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [confirm, setConfirm] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [left, setLeft] = useState(false)

  useEffect(() => {
    if (managed === null && !busy) onBack()
  }, [managed, busy, onBack])

  if (!managed) return null
  const org = managed.organization

  async function leave() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await request('managed:leave', {})
      setLeft(true)
      setConfirm(false)
      onBack()
      toast.success(t('managed.leftToast', { org: org.name }))
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div ref={ref} className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}>
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('managed.page.title')} subtitle={t('managed.page.intro')} onBack={onBack} />
        <div className="space-y-10">
          <section className="bg-surface-container-low rounded-xl p-6 flex items-center gap-5">
            <Tile icon="work" />
            <div className="min-w-0">
              <p className="text-2xl font-headline font-bold text-accent">{t('managed.page.managedBy', { org: org.name })}</p>
              <p className="text-sm text-on-surface-variant mt-1">{t('managed.page.updated', { when: formatDateTime(managed.updatedAt) })}</p>
            </div>
          </section>

          {(org.supportUrl || org.supportEmail) && (
            <section>
              <SectionHeading>{t('managed.page.support')}</SectionHeading>
              <div className={ROW_GROUP}>
                {org.supportUrl && <LinkRow icon="feedback" label={t('managed.page.supportPage')} desc={org.supportUrl} href={org.supportUrl} />}
                {org.supportEmail && <LinkRow icon="send" label={t('managed.page.emailSupport')} desc={org.supportEmail} href={`mailto:${org.supportEmail}`} />}
              </div>
            </section>
          )}

          <section>
            <SectionHeading>{t('managed.page.leaveHeading')}</SectionHeading>
            <div className="bg-surface-container-low rounded-xl p-6 flex items-center justify-between gap-4">
              <div className="min-w-0">
                <p className="font-semibold text-accent">{t('managed.page.leaveTitle')}</p>
                <p id="managed-leave-desc" className="text-xs text-on-surface-variant mt-0.5">{t('managed.page.leaveDesc', { org: org.name })}</p>
              </div>
              <Button variant="danger" onClick={() => setConfirm(true)} disabled={busy} ariaDescribedBy="managed-leave-desc" className="shrink-0">
                {t('managed.page.leaveAction')}
              </Button>
            </div>
          </section>
        </div>
      </div>
      <ConfirmDestructiveModal
        isOpen={confirm && !left}
        title={t('managed.leave.title', { org: org.name })}
        body={t('managed.leave.body')}
        confirmLabel={t('managed.leave.confirm')}
        onClose={() => { setConfirm(false); setError(null) }}
        onConfirm={() => runAction(leave)}
        busy={busy}
      >
        {managed.backupFolder && <Callout tone="note" icon="lock">{t('managed.leave.backupNote', { org: org.name })}</Callout>}
        {error && <InlineError>{error}</InlineError>}
      </ConfirmDestructiveModal>
    </div>
  )
}
