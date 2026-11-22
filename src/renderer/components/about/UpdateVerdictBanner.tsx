// About's update verdict: a lamp, what is true right now, and the one action that helps.
import { useTranslation } from 'react-i18next'
import { UPDATE_STATE, type UpdateStatus } from '../../../shared/contract/update-status.js'
import { formatDateTime } from '../../format/utils.js'
import { updateBodyKey, updateDownload, updateVerdict, type UpdateLamp } from '../../model/about-view.js'
import Button from '../primitives/Button.js'
import DownloadProgressLane from '../primitives/DownloadProgressLane.js'

const LAMP: Record<UpdateLamp, string> = {
  'up-to-date': 'bg-online ring-online/25',
  ready: 'bg-secondary-container ring-secondary-container/30',
  available: 'bg-secondary-container ring-secondary-container/30',
  neutral: 'bg-outline ring-outline/20',
}

interface UpdateVerdictBannerProps {
  status: UpdateStatus
  restarting: boolean
  onCheck: () => void
  onRestart: () => void
  onInstall: () => void
}

export default function UpdateVerdictBanner({ status, restarting, onCheck, onRestart, onInstall }: UpdateVerdictBannerProps) {
  const { t } = useTranslation()
  const verdict = updateVerdict(status)
  const download = updateDownload(status)
  const checking = status.state === UPDATE_STATE.CHECKING
  const checkLabel = checking ? 'about.checking' : verdict.key === 'error' ? 'about.tryAgain' : 'about.checkNow'

  return (
    <div className="bg-surface-container-low rounded-xl p-6 flex items-center gap-5">
      <span aria-hidden="true" className={`w-4 h-4 rounded-full shrink-0 ring-4 ${LAMP[verdict.lamp]}`} />
      <div className="flex-1 min-w-0">
        <div role="status" aria-live="polite">
          <p className="text-2xl font-headline font-bold text-accent">
            {t(`about.verdict.${verdict.key}Title`, { version: status.nextVersion ?? '' })}
          </p>
          <p className="text-sm text-on-surface-variant mt-1">
            {t(`about.verdict.${updateBodyKey(status)}Body`, { when: status.lastCheckedAt ? formatDateTime(status.lastCheckedAt) : '' })}
          </p>
        </div>
        {/* Outside the live region: a bar announces through its own value, never per tick. */}
        {download && (
          <div className="mt-3">
            <DownloadProgressLane
              value={download.percent ?? 0}
              label={t('about.downloadProgress')}
              indeterminate={download.indeterminate}
              indeterminateText={t('format.progressUnknown')}
              showPct={download.percent !== null}
            />
          </div>
        )}
      </div>
      {verdict.action === 'check' && (
        <Button variant="secondary" icon="refresh" onClick={() => { if (!checking) onCheck() }} ariaDisabled={checking}>
          {t(checkLabel)}
        </Button>
      )}
      {verdict.action === 'install' && (
        <Button icon="download" onClick={onInstall}>
          {t('about.install')}
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
