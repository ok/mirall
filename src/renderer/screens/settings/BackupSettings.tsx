// Backup & recovery: one place for the backup and the recovery key that opens it. Before setup it
// explains what a backup holds and offers to set one up; after, it shows each safeguard's state with
// its action, the folder, and the key.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useBackupStatus } from '../../hooks/useBackupStatus.js'
import { useIdentityProtection } from '../../hooks/useIdentityProtection.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useHasVerticalOverflow } from '../../hooks/useHasVerticalOverflow.js'
import { useSaveKeyCopy } from '../../hooks/useSaveKeyCopy.js'
import PageHeader from '../../components/layout/PageHeader.js'
import SectionHeading from '../../components/layout/SectionHeading.js'
import PathRow from '../../components/path/PathRow.js'
import Button from '../../components/primitives/Button.js'
import TextButton from '../../components/primitives/TextButton.js'
import Callout from '../../components/primitives/Callout.js'
import InlineError from '../../components/primitives/InlineError.js'
import ConfirmDestructiveModal from '../../components/modals/ConfirmDestructiveModal.js'
import RecoveryBackupModal from '../../components/modals/RecoveryBackupModal.js'
import ProtectionSummary from '../../components/backup/ProtectionSummary.js'
import BackupScopeList from '../../components/backup/BackupScopeList.js'
import BackupDialogs, { type BackupDialog } from '../../components/backup/BackupDialogs.js'

interface BackupSettingsProps {
  onBack: () => void
}

export default function BackupSettings({ onBack }: BackupSettingsProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const copy = useSaveKeyCopy()
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

  async function runNow() {
    if (status?.state === 'running') return
    setError(null)
    try {
      await request('backup:run', {}, 0)
    } catch (err) {
      setError(errorText(err))
    }
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
  const lastFailure = status?.state === 'error' && status.lastError ? errorText({ code: status.lastError }) : null

  return (
    <div ref={ref} className={`relative h-[calc(100vh-5.5rem-var(--banner-h,0px))] overflow-y-auto scrollbar-thin pb-8 mr-2 ${hasOverflow ? 'pr-4' : ''}`}>
      <div className="pt-8 px-8 max-w-2xl mx-auto">
        <PageHeader title={t('backup.title')} subtitle={t('backup.subtitle')} onBack={onBack} />
        {status && (
          <div className="space-y-10">
            {status.state === 'paused' && <Callout tone="note">{t('backup.paused')}</Callout>}
            {!setUp && status.state !== 'paused' && (
              <section className="bg-surface-container-low rounded-xl p-6 space-y-5">
                <h2 className="font-headline font-bold text-accent text-lg">{t('backup.offerTitle')}</h2>
                <p className="text-sm text-on-surface-variant leading-relaxed">{t('backup.offerBody')}</p>
                <BackupScopeList />
                <div className="flex flex-wrap items-center gap-4">
                  <Button icon="shield" onClick={() => setDialog('setup')}>{t('backup.setUp')}</Button>
                  <TextButton onClick={() => setKeyOnly(true)}>{t('backup.keyOnly')}</TextButton>
                </div>
              </section>
            )}
            {setUp && status.state !== 'paused' && (
              <>
                <section>
                  <SectionHeading>{t('backup.protection')}</SectionHeading>
                  <ProtectionSummary status={status} onRunNow={() => void runNow()} onSaveCopy={() => void copy.save()} savingCopy={copy.saving} />
                  {lastFailure && <InlineError className="mt-3">{lastFailure}</InlineError>}
                  {status.suspect && (
                    <Callout tone="warning" title={t('backup.suspectTitle')} className="mt-4">
                      {t('backup.suspectBody', { reasons: status.suspect.map((reason) => t(`backup.reason.${reason}`)).join(', ') })}
                    </Callout>
                  )}
                </section>
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
                  <div className="bg-surface-container-low rounded-xl p-6 space-y-4">
                    <p className="text-sm text-on-surface-variant">{t('backup.keyDesc')}</p>
                    <div className="flex flex-wrap items-center gap-4">
                      {status.key.createdAt
                        ? <Button variant="secondary" onClick={() => setDialog('check')}>{t('backup.checkKey')}</Button>
                        : <Button variant="secondary" onClick={() => setDialog('new-key')}>{t('backup.makeKey')}</Button>}
                      {status.key.createdAt && <TextButton onClick={() => setDialog('new-key')}>{t('backup.newKey')}</TextButton>}
                    </div>
                  </div>
                </section>
              </>
            )}
            {error && <InlineError>{error}</InlineError>}
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
