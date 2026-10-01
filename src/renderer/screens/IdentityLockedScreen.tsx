// The worker is up but this device's key cannot open its identity (a reset keychain, a moved data
// folder). The data is intact and stays locked until a recovery key opens it; starting fresh sets
// it aside rather than deleting it. Rendered before the toast region exists, so every failure is
// said on this screen.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { restartIntoIdentity } from '../hooks/useIdentityStatus.js'
import { useErrorText } from '../hooks/useErrorText.js'
import type { IdentityLockCode } from '../../shared/contract/errors.js'
import Logo from '../components/primitives/Logo.js'
import Icon from '../components/primitives/Icon.js'
import Button from '../components/primitives/Button.js'
import TextButton from '../components/primitives/TextButton.js'
import InlineError from '../components/primitives/InlineError.js'
import ConfirmDestructiveModal from '../components/modals/ConfirmDestructiveModal.js'
import RecoveryRestoreModal from '../components/modals/RecoveryRestoreModal.js'

interface IdentityLockedScreenProps {
  code: IdentityLockCode | null
}

export default function IdentityLockedScreen({ code }: IdentityLockedScreenProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const headingRef = useRef<HTMLHeadingElement>(null)
  const [restoreOpen, setRestoreOpen] = useState(false)
  const [confirmFresh, setConfirmFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    headingRef.current?.focus()
  }, [])

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
    <div className="min-h-screen flex flex-col">
      <header className="fixed top-0 w-full z-50" style={{ WebkitAppRegion: 'drag' }}>
        <div className="bg-surface-container-lowest/70 backdrop-blur-xl shadow-[0_12px_40px_rgba(74,59,82,0.06)] dark:shadow-none">
          <div className="flex items-center justify-center py-4 px-8 w-full max-w-7xl mx-auto">
            <span className="flex h-8 items-center text-on-surface">
              <Logo label="Mirall" />
            </span>
          </div>
        </div>
      </header>

      <main className="flex-grow flex flex-col items-center justify-center px-8 pt-24 pb-12">
        <div className="w-full max-w-md space-y-8">
          <div className="text-center space-y-4">
            <div className="mx-auto w-16 h-16 rounded-full bg-surface-container-high flex items-center justify-center text-secondary">
              <Icon name="lock" size={32} />
            </div>
            <h1
              ref={headingRef}
              tabIndex={-1}
              className="text-3xl md:text-4xl font-headline font-extrabold text-accent tracking-tight focus:outline-none"
            >
              {t('identityLocked.title')}
            </h1>
            <p className="text-lg text-on-surface-variant leading-relaxed">
              {t(code === 'IDENTITY_PROVIDER_MISMATCH' ? 'identityLocked.bodyProvider' : 'identityLocked.body')}
            </p>
          </div>

          <div className="bg-surface-container-low rounded-2xl p-6 space-y-3">
            <Button size="lg" fullWidth icon="lock" onClick={() => setRestoreOpen(true)} ariaDisabled={busy}>
              {t('identityLocked.restore')}
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
        </div>
      </main>

      <RecoveryRestoreModal isOpen={restoreOpen} onClose={() => setRestoreOpen(false)} onRestored={restartIntoIdentity} />
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
    </div>
  )
}
