// The banner under the top nav while a restore is being confirmed: why changes wait, and the way to the
// details. It takes the update banner's place while shown, and cannot be dismissed — it is the reason
// the disabled controls give. A restart that failed after the confirmation is said here, with a retry.
import { useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useBannerHeight } from '../../hooks/useBannerHeight.js'
import { HELD_REASON_ID } from '../../hooks/useHeldControl.js'
import { restoreBannerCopy, type RestoreHoldView } from '../../model/restore-hold-view.js'
import Icon from '../primitives/Icon.js'

// The reason every control a restore holds points at (aria-describedby), said once here.

interface RestoreBannerProps {
  hold: RestoreHoldView
  restartFailed: boolean
  onRetryRestart: () => void
  onDetails: () => void
}

export default function RestoreBanner({ hold, restartFailed, onRetryRestart, onDetails }: RestoreBannerProps) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)
  useBannerHeight(ref, true)
  const copy = restoreBannerCopy(hold)
  return (
    <div ref={ref} role="status" aria-live="polite" className="bg-secondary-container px-8 py-2 flex items-center justify-between gap-4" style={{ WebkitAppRegion: 'no-drag' }}>
      <span id={HELD_REASON_ID} className="sr-only">{t('restore.heldReason')}</span>
      <div className="flex items-center gap-2 min-w-0">
        <Icon name="history" size={16} className="text-on-secondary-container shrink-0" />
        <span className="text-sm font-semibold text-on-secondary-container">
          {restartFailed ? t('restore.restartFailed') : t(copy.lead)}
          {!restartFailed && <span className="ml-2 opacity-80">— {t(copy.detail)}{copy.waiting ? ` ${t('restore.bannerWaiting')}` : ''}</span>}
        </span>
      </div>
      <button
        type="button"
        onClick={restartFailed ? onRetryRestart : onDetails}
        className="bg-secondary text-on-secondary text-xs font-bold px-3 py-1 rounded shadow-lg hover:opacity-90 active:scale-95 transition-all focus-ring shrink-0"
      >
        {restartFailed ? t('identityLocked.retry') : t('restore.details')}
      </button>
    </div>
  )
}
