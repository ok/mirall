// Banner under the top nav shown when an update has been downloaded and will apply on next start.
import { useRef, useLayoutEffect } from 'react'
import { useTranslation } from 'react-i18next'
import type { UpdateInfo } from '../../types.js'
import Icon from '../primitives/Icon.js'

interface UpdateBannerProps {
  update: UpdateInfo | null
  onDismiss: () => void
}

export default function UpdateBanner({ update, onDismiss }: UpdateBannerProps) {
  const { t } = useTranslation()
  const ref = useRef<HTMLDivElement>(null)

  // Publish the banner's live height as --banner-h on :root so the fixed nav's
  // content offset (app.tsx <main>) and every screen's `100vh - navHeight`
  // scroll area can grow by exactly this much — pushing content down instead of
  // letting the banner overlay it. ResizeObserver keeps it correct if the text
  // wraps on a narrow window. Reset to 0 whenever the banner isn't shown.
  useLayoutEffect(() => {
    const root = document.documentElement
    const el = ref.current
    if (!el) {
      root.style.setProperty('--banner-h', '0px')
      return
    }
    const apply = () => root.style.setProperty('--banner-h', `${el.offsetHeight}px`)
    apply()
    const ro = new ResizeObserver(apply)
    ro.observe(el)
    return () => {
      ro.disconnect()
      root.style.setProperty('--banner-h', '0px')
    }
  }, [update])

  if (!update) return null

  const version = update.version.semver
    ? update.version.semver
    : `${update.version.fork}.${update.version.length}`

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
        className="bg-secondary text-on-secondary text-xs font-bold px-3 py-1 rounded shadow-lg hover:opacity-90 active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
      >
        {t('updateBanner.dismiss')}
      </button>
    </div>
  )
}
