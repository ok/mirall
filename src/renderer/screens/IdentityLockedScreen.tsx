// The worker is up but this device's key cannot open its identity (a reset keychain, a moved data
// folder). The data is intact and stays locked until a recovery key opens it; starting fresh sets
// it aside rather than deleting it. Rendered before the toast region exists, so every failure is
// said on this screen.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { restartIntoIdentity } from '../hooks/useIdentityStatus.js'
import { useErrorText } from '../hooks/useErrorText.js'
import type { IdentityLockCode } from '../../shared/contract/errors.js'
import PreShellHero from '../components/layout/PreShellHero.js'
import Button from '../components/primitives/Button.js'
import TextButton from '../components/primitives/TextButton.js'
import InlineError from '../components/primitives/InlineError.js'
import ConfirmDestructiveModal from '../components/modals/ConfirmDestructiveModal.js'
import RecoveryRestoreModal from '../components/modals/RecoveryRestoreModal.js'
import RestoreBackupModal from '../components/modals/RestoreBackupModal.js'
import { isLocalBackupFeatureOn } from '../platform/config-client.js'

interface IdentityLockedScreenProps {
  code: IdentityLockCode | null
}

export default function IdentityLockedScreen({ code }: IdentityLockedScreenProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [backupOpen, setBackupOpen] = useState(false)
  const [confirmFresh, setConfirmFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function run(action: () => Promise<void>) {
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

  const retry = () => run(async () => {
    await window.bridge.retryIdentityUnlock()
    await restartIntoIdentity()
  })

  const startFresh = () => run(async () => {
    await request('identity:set-aside')
    setConfirmFresh(false)
    await restartIntoIdentity()
  })

  return (
    <>
      <PreShellHero
        icon="lock"
        title={t('identityLocked.title')}
        body={t(code === 'IDENTITY_PROVIDER_MISMATCH' ? 'identityLocked.bodyProvider' : 'identityLocked.body')}
      >
        <div className="bg-surface-container-low rounded-2xl p-6 space-y-3">
          <Button size="lg" fullWidth icon="lock" onClick={() => setRestoreOpen(true)} ariaDisabled={busy}>
            {t('identityLocked.restore')}
          </Button>
          {isLocalBackupFeatureOn() && (
            <Button size="lg" fullWidth variant="secondary" icon="history" onClick={() => setBackupOpen(true)} ariaDisabled={busy}>
              {t('identityLocked.restoreBackup')}
            </Button>
          )}
          <Button size="lg" fullWidth variant="secondary" icon="refresh" onClick={() => void retry()} ariaDisabled={busy}>
            {t('identityLocked.retry')}
          </Button>
        </div>

        <div className="text-center space-y-2">
          <TextButton onClick={() => { setError(null); setConfirmFresh(true) }}>{t('identityLocked.startFresh')}</TextButton>
          <p className="text-sm text-on-surface-variant">{t('identityLocked.startFreshHint')}</p>
        </div>

        {error && !confirmFresh && <InlineError id="identity-locked-error" className="text-center">{error}</InlineError>}
      </PreShellHero>

      <RecoveryRestoreModal isOpen={restoreOpen} onClose={() => setRestoreOpen(false)} onRestored={restartIntoIdentity} />
      <RestoreBackupModal isOpen={backupOpen} onClose={() => setBackupOpen(false)} onRestored={restartIntoIdentity} />
      <ConfirmDestructiveModal
        isOpen={confirmFresh}
        title={t('identityLocked.startFreshTitle')}
        body={t('identityLocked.startFreshBody')}
        confirmLabel={t('identityLocked.startFreshConfirm')}
        onClose={() => setConfirmFresh(false)}
        onConfirm={() => void startFresh()}
        busy={busy}
      >
        {error && <InlineError id="identity-fresh-error">{error}</InlineError>}
      </ConfirmDestructiveModal>
    </>
  )
}
