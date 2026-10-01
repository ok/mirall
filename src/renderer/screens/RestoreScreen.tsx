// A recovery key brought the identity back but not its profile: the peers that hold the profile send
// it before anything here may write to it. An invite to any of the user's spaces is how a device
// with no spaces reaches one of them. Rendered before the toast region exists, so every failure is
// said on this screen.
import { useEffect, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { refetchQuery } from '../store/query-store.js'
import { restartIntoIdentity } from '../hooks/useIdentityStatus.js'
import { useErrorText } from '../hooks/useErrorText.js'
import { RESTORE_VERDICT } from '../../shared/contract/restore-verdict.js'
import type { RestoreProgress } from '../../shared/contract/responses.js'
import PreShellHero from '../components/layout/PreShellHero.js'
import Icon from '../components/primitives/Icon.js'
import Button from '../components/primitives/Button.js'
import TextButton from '../components/primitives/TextButton.js'
import TextField from '../components/primitives/TextField.js'
import ProgressBar from '../components/primitives/ProgressBar.js'
import InlineError from '../components/primitives/InlineError.js'
import ConfirmDestructiveModal from '../components/modals/ConfirmDestructiveModal.js'

const POLL_MS = 2000

interface RestoreScreenProps {
  progress: RestoreProgress
  restartFailed: boolean
  onRetryRestart: () => void
}

function statusKey(progress: RestoreProgress) {
  if (progress.released) return 'restore.statusDone'
  if (progress.verdict === RESTORE_VERDICT.NO_HOLDER) return 'restore.statusWaiting'
  if (progress.verdict === RESTORE_VERDICT.DWELL || progress.verdict === RESTORE_VERDICT.CAUGHT_UP) return 'restore.statusChecking'
  return 'restore.statusReceiving'
}

export default function RestoreScreen({ progress, restartFailed, onRetryRestart }: RestoreScreenProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const [invite, setInvite] = useState('')
  const [joined, setJoined] = useState(false)
  const [confirmFresh, setConfirmFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    if (progress.released) return undefined
    const timer = setInterval(() => {
      refetchQuery('identity:status').catch((err: Error) => console.warn('restore status re-read failed:', err.message))
    }, POLL_MS)
    return () => clearInterval(timer)
  }, [progress.released])

  async function join() {
    const inviteCode = invite.trim()
    if (!inviteCode || busy) return
    setBusy(true)
    setInviteError(null)
    try {
      await request('space:join', { inviteCode })
      setInvite('')
      setJoined(true)
    } catch (err) {
      setInviteError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  async function startFresh() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      await request('identity:set-aside')
      setConfirmFresh(false)
      await restartIntoIdentity()
    } catch (err) {
      setError(errorText(err))
    } finally {
      setBusy(false)
    }
  }

  const receiving = progress.verdict === RESTORE_VERDICT.BEHIND || progress.verdict === RESTORE_VERDICT.DOWNLOADING
  const percent = progress.target > 0 ? Math.min(100, Math.round((progress.length / progress.target) * 100)) : 0
  const waiting = progress.verdict === RESTORE_VERDICT.NO_HOLDER && !progress.released

  return (
    <>
      <PreShellHero icon="history" title={t('restore.title')} body={t('restore.body')}>
        <div role="status" aria-live="polite" className="rounded-2xl p-4 flex items-center gap-3 bg-surface-container-low">
          <Icon
            name={progress.released ? 'check_circle' : 'refresh'}
            size={24}
            className={`text-secondary shrink-0${progress.released ? '' : ' motion-safe:animate-spin'}`}
          />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-accent">{t(statusKey(progress))}</p>
            {receiving && <ProgressBar value={percent} label={t('restore.progressLabel')} />}
          </div>
        </div>

        {restartFailed && (
          <div className="space-y-3">
            <InlineError id="restore-restart-error" className="text-center">{t('restore.restartFailed')}</InlineError>
            <Button size="lg" fullWidth variant="secondary" icon="refresh" onClick={onRetryRestart}>
              {t('identityLocked.retry')}
            </Button>
          </div>
        )}

        {waiting && (
          <div className="space-y-3">
            <TextField
              id="restore-invite"
              label={t('restore.inviteLabel')}
              placeholder={t('joinSpace.codePlaceholder')}
              value={invite}
              onChange={(v) => { setInvite(v); setInviteError(null) }}
              onKeyDown={(e) => { if (e.key === 'Enter') void join() }}
              help={joined ? t('restore.inviteJoined') : t('restore.inviteHelp')}
              error={inviteError}
            />
            <Button size="lg" fullWidth icon="group_add" onClick={() => void join()} disabled={!invite.trim()} ariaDisabled={busy}>
              {t('restore.inviteJoin')}
            </Button>
          </div>
        )}

        {!progress.released && (
          <div className="text-center space-y-2">
            <TextButton onClick={() => { setError(null); setConfirmFresh(true) }}>{t('restore.startFresh')}</TextButton>
            <p className="text-sm text-on-surface-variant">{t('restore.startFreshHint')}</p>
          </div>
        )}

        {error && !confirmFresh && <InlineError id="restore-error" className="text-center">{error}</InlineError>}
      </PreShellHero>

      <ConfirmDestructiveModal
        isOpen={confirmFresh}
        title={t('identityLocked.startFreshTitle')}
        body={t('restore.startFreshBody')}
        confirmLabel={t('identityLocked.startFreshConfirm')}
        onClose={() => setConfirmFresh(false)}
        onConfirm={() => void startFresh()}
        busy={busy}
      >
        {error && <InlineError id="restore-fresh-error">{error}</InlineError>}
      </ConfirmDestructiveModal>
    </>
  )
}
