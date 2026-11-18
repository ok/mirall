// The worker is up but this device's key cannot open its identity (a reset keychain, a moved data
// folder). The data is intact and stays locked until a recovery key opens it; starting fresh sets
// it aside rather than deleting it. Every action here opens the identity in the running worker. Rendered before the toast region exists, so every failure is
// said on this screen.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { adoptOpenedIdentity } from '../hooks/useIdentityStatus.js'
import { refetchQuery } from '../store/query-store.js'
import { useErrorText } from '../hooks/useErrorText.js'
import type { IdentityLockCode } from '../../shared/contract/errors.js'
import PreShellHero from '../components/layout/PreShellHero.js'
import Button from '../components/primitives/Button.js'
import TextButton from '../components/primitives/TextButton.js'
import InlineError from '../components/primitives/InlineError.js'
import ConfirmDestructiveModal from '../components/modals/ConfirmDestructiveModal.js'
import RestoreBackupModal from '../components/modals/RestoreBackupModal.js'

interface IdentityLockedScreenProps {
  code: IdentityLockCode | null
}

export default function IdentityLockedScreen({ code }: IdentityLockedScreenProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [restoreOpen, setRestoreOpen] = useState(false)
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
      // A recovery whose reopen failed may have left the worker locked on another code.
      await refetchQuery('identity:status').catch(() => null)
    } finally {
      setBusy(false)
    }
  }

  // The worker answers once it is live, which can take as long as a boot, so no request deadline.
  const retry = () => run(async () => {
    if (await window.bridge.retryIdentityUnlock()) await adoptOpenedIdentity()
    else await refetchQuery('identity:status')
  })

  const startFresh = () => run(async () => {
    await request('identity:set-aside', {}, 0)
    setConfirmFresh(false)
    await adoptOpenedIdentity()
  })

  return (
    <>
      <PreShellHero
        icon="lock"
        title={t('identityLocked.title')}
        body={t(code === 'IDENTITY_PROVIDER_MISMATCH' ? 'identityLocked.bodyProvider' : 'identityLocked.body')}
      >
        <div className="bg-surface-container-low rounded-2xl p-6 space-y-3">
          <Button size="lg" fullWidth icon="history" onClick={() => setRestoreOpen(true)} ariaDisabled={busy}>
            {t('identityLocked.restoreAccount')}
          </Button>
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

      <RestoreBackupModal isOpen={restoreOpen} locked onClose={() => setRestoreOpen(false)} onRestored={adoptOpenedIdentity} />
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
