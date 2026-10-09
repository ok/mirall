// About's update verdict: a lamp, what is true right now, and the one action that helps.
import { useTranslation } from 'react-i18next'
import { UPDATE_STATE, type UpdateStatus } from '../../../shared/contract/update-status.js'
import { formatDateTime } from '../../format/utils.js'
import { updateVerdict, type UpdateLamp } from '../../model/about-view.js'
import Button from '../primitives/Button.js'

const LAMP: Record<UpdateLamp, string> = {
  'up-to-date': 'bg-online ring-online/25',
  ready: 'bg-secondary-container ring-secondary-container/30',
  neutral: 'bg-outline ring-outline/20',
}

interface UpdateVerdictBannerProps {
  status: UpdateStatus
  restarting: boolean
  onCheck: () => void
  onRestart: () => void
}

export default function UpdateVerdictBanner({ status, restarting, onCheck, onRestart }: UpdateVerdictBannerProps) {
  const { t } = useTranslation()
  const verdict = updateVerdict(status)
  const checking = status.state === UPDATE_STATE.CHECKING
  const checkLabel = checking ? 'about.checking' : verdict.key === 'error' ? 'about.tryAgain' : 'about.checkNow'

  return (
    <div className="bg-surface-container-low rounded-xl p-6 flex items-center gap-5">
      <span aria-hidden="true" className={`w-4 h-4 rounded-full shrink-0 ring-4 ${LAMP[verdict.lamp]}`} />
      <div role="status" aria-live="polite" className="flex-1 min-w-0">
        <p className="text-2xl font-headline font-bold text-accent">
          {t(`about.verdict.${verdict.key}Title`, { version: status.nextVersion ?? '' })}
        </p>
        <p className="text-sm text-on-surface-variant mt-1">
          {t(`about.verdict.${verdict.key}Body`, { when: status.lastCheckedAt ? formatDateTime(status.lastCheckedAt) : '' })}
        </p>
      </div>
      {verdict.action === 'check' && (
        <Button variant="secondary" icon="refresh" onClick={() => { if (!checking) onCheck() }} ariaDisabled={checking}>
          {t(checkLabel)}
        </Button>
      )}
      {verdict.action === 'restart' && (
        <Button onClick={() => { if (!restarting) onRestart() }} ariaDisabled={restarting}>
          {t(restarting ? 'about.restarting' : 'about.restartNow')}
        </Button>
      )}
    </div>
  )
}
