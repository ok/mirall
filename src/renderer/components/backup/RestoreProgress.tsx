// The restore's details on Protection status: how far the profile has come, which spaces are still
// being confirmed, and the two ways out of a wait nobody answers — rejoining a space with an invite,
// or starting a new identity. The app around it stays usable for everything that does not write.
import { useState } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../../ipc/ipc.js'
import { restartIntoIdentity } from '../../hooks/useIdentityStatus.js'
import { useErrorText } from '../../hooks/useErrorText.js'
import { useSpaces } from '../../hooks/useSpaces.js'
import { RESTORE_VERDICT } from '../../../shared/contract/restore-verdict.js'
import type { RestoreHoldView } from '../../model/restore-hold-view.js'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import TextButton from '../primitives/TextButton.js'
import TextField from '../primitives/TextField.js'
import ProgressBar from '../primitives/ProgressBar.js'
import InlineError from '../primitives/InlineError.js'
import ConfirmDestructiveModal from '../modals/ConfirmDestructiveModal.js'

function statusKey(progress: NonNullable<RestoreHoldView['progress']>) {
  if (progress.released) return 'restore.statusDone'
  if (progress.verdict === RESTORE_VERDICT.NO_HOLDER) return 'restore.statusWaiting'
  if (progress.verdict === RESTORE_VERDICT.DWELL || progress.verdict === RESTORE_VERDICT.CAUGHT_UP) return 'restore.statusChecking'
  return 'restore.statusReceiving'
}

interface RestoreProgressProps {
  hold: RestoreHoldView
}

export default function RestoreProgress({ hold }: RestoreProgressProps) {
  const { t } = useTranslation()
  const errorText = useErrorText()
  const { spaces } = useSpaces()
  const [invite, setInvite] = useState('')
  const [joined, setJoined] = useState(false)
  const [confirmFresh, setConfirmFresh] = useState(false)
  const [busy, setBusy] = useState(false)
  const [inviteError, setInviteError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

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

  const progress = hold.progress
  const receiving = progress?.verdict === RESTORE_VERDICT.BEHIND || progress?.verdict === RESTORE_VERDICT.DOWNLOADING
  const percent = progress && progress.target > 0 ? Math.min(100, Math.round((progress.length / progress.target) * 100)) : 0
  const waiting = progress?.verdict === RESTORE_VERDICT.NO_HOLDER && !progress.released
  const checking = spaces.filter((space) => hold.heldSpaceIds.includes(space.spaceId))

  return (
    <div className="bg-surface-container-low rounded-xl p-6 space-y-5">
      {progress && (
        <div role="status" aria-live="polite" className="flex items-center gap-3">
          <Icon name={progress.released ? 'check_circle' : 'refresh'} size={22} className={`text-secondary shrink-0${progress.released ? '' : ' motion-safe:animate-spin'}`} />
          <div className="flex-1 min-w-0">
            <p className="font-bold text-on-surface">{t(statusKey(progress))}</p>
            {receiving && <ProgressBar value={percent} label={t('restore.progressLabel')} />}
          </div>
        </div>
      )}
      {checking.length > 0 && (
        <div>
          <p className="text-sm font-semibold text-accent mb-2">{t('restore.spacesChecking')}</p>
          <ul className="text-sm text-on-surface-variant space-y-1">
            {checking.map((space) => <li key={space.spaceId}>{space.name}</li>)}
          </ul>
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
          <Button icon="group_add" onClick={() => void join()} disabled={!invite.trim()} ariaDisabled={busy}>
            {t('restore.inviteJoin')}
          </Button>
        </div>
      )}
      {progress && !progress.released && (
        <div className="space-y-1">
          <TextButton onClick={() => { setError(null); setConfirmFresh(true) }}>{t('restore.startFresh')}</TextButton>
          <p className="text-xs text-on-surface-variant">{t('restore.startFreshHint')}</p>
        </div>
      )}
      {error && !confirmFresh && <InlineError id="restore-error">{error}</InlineError>}
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
    </div>
  )
}
