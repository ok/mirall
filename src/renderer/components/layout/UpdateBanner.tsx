// Banner under the top nav shown when an update has been downloaded and will apply on next start,
// or when a newer version waits for the user's go-ahead.
import { useRef } from 'react'
import { useBannerHeight } from '../../hooks/useBannerHeight.js'
import { useTranslation } from 'react-i18next'
import Icon from '../primitives/Icon.js'
import type { BannerUpdate } from '../../platform/update-state.js'

interface UpdateBannerProps {
  update: BannerUpdate | null
  onDismiss: () => void
  onInstall: () => void
}

const ACTION = 'text-xs font-bold px-3 py-1 rounded focus-ring-on-secondary'

export default function UpdateBanner({ update, onDismiss, onInstall }: UpdateBannerProps) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)

  useBannerHeight(ref, update !== null)

  if (!update) return null
  const { version } = update
  if (update.kind === 'available') {
    return (
      <div
        ref={ref}
        role="status"
        aria-live="polite"
        className="bg-secondary-container px-8 py-2 flex items-center justify-between"
        style={{ WebkitAppRegion: 'no-drag' }}
      >
        <div className="flex items-center gap-2">
          <Icon name="update" size={16} className="text-on-secondary-container" />
          <span className="text-sm font-semibold text-on-secondary-container">{t('updateBanner.offered', { version })}</span>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={onDismiss} className={`${ACTION} text-on-secondary-container hover:bg-secondary/10`}>
            {t('updateBanner.later')}
          </button>
          <button onClick={onInstall} className={`${ACTION} bg-secondary text-on-secondary shadow-lg hover:opacity-90 active:scale-95 transition-all`}>
            {t('updateBanner.install')}
          </button>
        </div>
      </div>
    )
  }

  return (
    <div
      ref={ref}
      role="status"
      aria-live="polite"
      className="bg-secondary-container px-8 py-2 flex items-center justify-between"
      style={{ WebkitAppRegion: 'no-drag' }}
    >
      <div className="flex items-center gap-2">
        <Icon name="update" size={16} className="text-on-secondary-container" />
        <span className="text-sm font-semibold text-on-secondary-container">
          {t('updateBanner.available', { version })}
          <span className="ml-2 opacity-80">— {t('updateBanner.appliedOnNextStart')}</span>
        </span>
      </div>
      <button
        onClick={onDismiss}
        className="bg-secondary text-on-secondary text-xs font-bold px-3 py-1 rounded shadow-lg hover:opacity-90 active:scale-95 transition-all focus-ring-on-secondary"
      >
        {t('updateBanner.dismiss')}
      </button>
    </div>
  )
}
