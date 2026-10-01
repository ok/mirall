// Backup & recovery settings: where the backup lives, the recovery key's passphrase and its reminder,
// and how to restore on a new computer. Configuration only, like Settings → Network; what is protected
// right now, and the actions that keep it so, are on the Protection screen it links to.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useBackupStatus } from '../../hooks/useBackupStatus.js'
import { useIdentityProtection } from '../../hooks/useIdentityProtection.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import PageHeader from '../../components/layout/PageHeader.js'
import SectionHeading from '../../components/layout/SectionHeading.js'
import ActionRow, { ROW_GROUP } from '../../components/layout/ActionRow.js'
import PathRow from '../../components/path/PathRow.js'
import Button from '../../components/primitives/Button.js'
import TextButton from '../../components/primitives/TextButton.js'
import Toggle from '../../components/primitives/Toggle.js'
import Callout from '../../components/primitives/Callout.js'
import InlineError from '../../components/primitives/InlineError.js'
import ConfirmDestructiveModal from '../../components/modals/ConfirmDestructiveModal.js'
import RecoveryBackupModal from '../../components/modals/RecoveryBackupModal.js'
import BackupDialogs, { type BackupDialog } from '../../components/backup/BackupDialogs.js'

interface BackupSettingsProps {
  onBack: () => void
  onOpenStatus: () => void
}

export default function BackupSettings({ onBack, onOpenStatus }: BackupSettingsProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const status = useBackupStatus()
  const protection = useIdentityProtection()
  const { ref, hasOverflow } = useHasVerticalOverflow<HTMLDivElement>()
  const [dialog, setDialog] = useState<BackupDialog>(null)
  const [confirmOff, setConfirmOff] = useState(false)
  const [keyOnly, setKeyOnly] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [offError, setOffError] = useState<string | null>(null)

  async function act(action: () => Promise<void>) {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await action()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function changeFolder() {
    const picked = await window.bridge.browseBackupFolder()
    if (picked) await request('backup:configure', { folder: picked.folder })
  }

  async function setReminders(enabled: boolean) {
    await request('backup:reminders', { enabled })
  }

  async function turnOff() {
    if (busy) return
    setBusy(true)
    setOffError(null)
    try {
      await request('backup:turn-off', {})
      setConfirmOff(false)
    } catch (err) {
      setOffError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const onChangeFolder = () => void act(changeFolder)
  const setUp = !!status?.folder

  return (
    <div ref={ref} className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}>
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('backup.title')} subtitle={t('backup.subtitle')} onBack={onBack} />
        {status && (
          <div className="space-y-10">
            {status.state === 'paused' && <Callout tone="note">{t('backup.paused')}</Callout>}
            {!setUp && status.state !== 'paused' && (
              <section className="bg-surface-container-low rounded-xl p-6 space-y-5">
                <h2 className="font-headline font-bold text-accent text-lg">{t('backup.setUpTitle')}</h2>
                <p className="text-sm text-on-surface-variant leading-relaxed">{t('backup.setUpBody')}</p>
                <div className="flex flex-wrap items-center gap-4">
                  <Button icon="shield" onClick={() => setDialog('setup')}>{t('backup.setUp')}</Button>
                  <TextButton onClick={() => setKeyOnly(true)}>{t('backup.keyOnly')}</TextButton>
                </div>
              </section>
            )}
            {setUp && status.state !== 'paused' && (
              <>
                <section>
                  <SectionHeading>{t('backup.folderTitle')}</SectionHeading>
                  <div className="bg-surface-container-low rounded-xl p-6 space-y-4">
                    <p id="backup-folder-desc" className="text-sm text-on-surface-variant">{t('backup.folderDesc')}</p>
                    <PathRow
                      path={status.folder}
                      onAction={onChangeFolder}
                      subject={t('backup.folderSubject')}
                      actionDisabled={busy}
                      ariaDescribedBy="backup-folder-desc"
                      fill="lowest"
                    />
                    <TextButton onClick={() => setConfirmOff(true)}>{t('backup.turnOff')}</TextButton>
                  </div>
                </section>
                <section>
                  <SectionHeading>{t('backup.keyTitle')}</SectionHeading>
                  <div className="bg-surface-container-low rounded-xl overflow-hidden">
                    <div className="p-6 flex items-center justify-between gap-4">
                      <div className="min-w-0">
                        <p className="font-semibold text-accent">{t('backup.passphraseTitle')}</p>
                        <p className="text-xs text-on-surface-variant">{t('backup.passphraseDesc')}</p>
                      </div>
                      <Button variant="secondary" onClick={() => setDialog('new-key')}>
                        {t(status.key.createdAt ? 'backup.changePassphrase' : 'backup.makeKey')}
                      </Button>
                    </div>
                    <Toggle
                      label={t('backup.remindersLabel')}
                      description={t('backup.remindersDesc')}
                      checked={status.key.reminders}
                      disabled={!status.key.createdAt}
                      onChange={(next) => void act(() => setReminders(next))}
                    />
                  </div>
                </section>
              </>
            )}
            {error && <InlineError>{error}</InlineError>}
            <section>
              <SectionHeading>{t('backup.restoreTitle')}</SectionHeading>
              <div className="bg-surface-container-low rounded-xl p-6 space-y-3">
                <ol className="list-decimal pl-5 space-y-2 text-sm text-on-surface-variant">
                  <li>{t('backup.restoreStep1')}</li>
                  <li>{t('backup.restoreStep2')}</li>
                  <li>{t('backup.restoreStep3')}</li>
                </ol>
                <p className="text-xs text-on-surface-variant">{t('backup.restoreKeyOnly')}</p>
              </div>
            </section>
            <section>
              <div className={ROW_GROUP}>
                <ActionRow icon="shield" label={t('protection.openStatus')} desc={t('protection.openStatusDesc')} onClick={onOpenStatus} />
              </div>
            </section>
          </div>
        )}
      </div>
      <BackupDialogs open={dialog} onChange={setDialog} />
      <ConfirmDestructiveModal
        isOpen={confirmOff}
        title={t('backup.turnOffTitle')}
        body={t('backup.turnOffBody')}
        confirmLabel={t('backup.turnOffConfirm')}
        onClose={() => { setConfirmOff(false); setOffError(null) }}
        onConfirm={() => void turnOff()}
        busy={busy}
      >
        {offError && <InlineError>{offError}</InlineError>}
      </ConfirmDestructiveModal>
      <RecoveryBackupModal isOpen={keyOnly} onClose={() => setKeyOnly(false)} weakProtection={protection === 'weak'} />
    </div>
  )
}
