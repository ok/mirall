// The local backup on the Storage screen: the folder it writes to, when it last did, and why it could
// not. Backups run on their own; "Back up now" only runs one sooner, and the status line follows the
// run, so the card's other actions stay available meanwhile. A backup that looks like data was lost
// says so, with the reasons, and stays visible until a backup that does not.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import type { BackupStatus } from '../../../shared/contract/responses.js'
import PathRow from '../path/PathRow.js'
import Button from '../primitives/Button.js'
import TextButton from '../primitives/TextButton.js'
import Callout from '../primitives/Callout.js'
import InlineError from '../primitives/InlineError.js'

interface BackupCardProps {
  status: BackupStatus
}

export default function BackupCard({ status }: BackupCardProps) {
  const { t, i18n } = useTranslation()
  const errorText = useErrorText()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

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

  async function chooseFolder() {
    const picked = await window.bridge.browseBackupFolder()
    if (picked) await request('backup:configure', { folder: picked })
  }

  async function runNow() {
    if (status.state === 'running') return
    setError(null)
    try {
      await request('backup:run', {}, 0)
    } catch (err) {
      setError(errorText(err))
    }
  }

  async function turnOff() {
    await request('backup:turn-off', {})
  }

  const lastFailure = status.state === 'error' && status.lastError ? errorText({ code: status.lastError }) : null
  const statusLine = status.state === 'running'
    ? t('backup.running')
    : status.lastSuccessAt
      ? t('backup.lastBackup', { when: new Date(status.lastSuccessAt).toLocaleString(i18n.language, { dateStyle: 'medium', timeStyle: 'short' }) })
      : t('backup.never')

  return (
    <div className="bg-surface-container-low rounded-xl p-6 space-y-4">
      <p id="backup-desc" className="text-sm text-on-surface-variant">{t('backup.desc')}</p>
      <PathRow
        path={status.folder}
        onAction={status.state === 'paused' ? undefined : () => void act(chooseFolder)}
        subject={t('backup.folderSubject')}
        actionDisabled={busy}
        ariaDescribedBy="backup-desc"
        fill="lowest"
      />
      {status.state === 'paused' && <Callout tone="note">{t('backup.paused')}</Callout>}
      {!status.folder && status.state !== 'paused' && <Callout tone="note">{t('backup.needsRecoveryKey')}</Callout>}
      {status.folder && status.state !== 'paused' && (
        <>
          <p role="status" className="text-sm text-on-surface-variant">{statusLine}</p>
          {lastFailure && <InlineError>{lastFailure}</InlineError>}
          {status.suspect && (
            <Callout tone="warning" title={t('backup.suspectTitle')}>
              {t('backup.suspectBody', { reasons: status.suspect.map((reason) => t(`backup.reason.${reason}`)).join(', ') })}
            </Callout>
          )}
          <div className="flex items-center gap-4">
            <Button variant="secondary" onClick={() => void runNow()} ariaDisabled={status.state === 'running'}>
              {t('backup.runNow')}
            </Button>
            <TextButton onClick={() => void act(turnOff)}>{t('backup.turnOff')}</TextButton>
          </div>
        </>
      )}
      {error && <InlineError>{error}</InlineError>}
    </div>
  )
}
