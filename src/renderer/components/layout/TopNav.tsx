// Fixed top bar doubling as the window drag region: logo, feedback/settings/account
// controls (the avatar ring reflects connection status), with the update banner beneath.
import { useTranslation } from 'react-i18next'
import UpdateBanner from './UpdateBanner.js'
import type { Profile, UpdateInfo } from '../../types.js'
import { useConnectionStatus } from '../../hooks/useConnectionStatus.js'
import Icon from '../primitives/Icon.js'
import Button from '../primitives/Button.js'
import IconButton from '../primitives/IconButton.js'
import Avatar from '../primitives/Avatar.js'
import Logo from '../primitives/Logo.js'

interface TopNavProps {
  profile: Profile | null
  onLogoClick: () => void
  onSettingsClick: () => void
  onAccountClick: () => void
  onFeedbackClick: () => void
  update: UpdateInfo | null
  onDismissUpdate: () => void
}

export default function TopNav({ profile, onLogoClick, onSettingsClick, onAccountClick, onFeedbackClick, update, onDismissUpdate }: TopNavProps) {
  const { t } = useTranslation()
  const { state } = useConnectionStatus()
  const hasIssue = state === 'offline' || state === 'connecting' || state === 'limited'
  const statusVariant = state === 'offline' ? 'offline' : hasIssue ? 'connecting' : 'ok'

  return (
    <nav className="fixed top-0 w-full z-50" style={{ WebkitAppRegion: 'drag' }}>
      <div className="bg-surface-container-lowest/70 backdrop-blur-xl shadow-[0_12px_40px_rgba(74,59,82,0.06)] dark:shadow-none">
        <div className="flex items-center py-4 px-8 w-full max-w-7xl mx-auto relative">
          <div className="absolute inset-0 flex items-center justify-center pointer-events-none">
            <button
              type="button"
              onClick={onLogoClick}
              aria-label={t('shortcuts.home')}
              title={t('shortcuts.home')}
              style={{ WebkitAppRegion: 'no-drag' }}
              className="pointer-events-auto flex h-8 items-center text-black dark:text-white rounded-lg px-2 active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
            >
              <Logo />
            </button>
          </div>
          <div className="flex items-center gap-4 ml-auto" style={{ WebkitAppRegion: 'no-drag' }}>
            <Button variant="secondary" icon="feedback" onClick={onFeedbackClick}>
              {t('topnav.feedback')}
            </Button>
            <IconButton
              icon="settings"
              iconFilled
              iconSize={28}
              onClick={onSettingsClick}
              ariaLabel={t('topnav.settings')}
            />
            <button
              type="button"
              onClick={onAccountClick}
              aria-label={hasIssue ? t('topnav.accountWithIssue') : t('topnav.account')}
              title={hasIssue ? t('topnav.accountWithIssue') : t('topnav.account')}
              className="w-10 h-10 rounded-full flex items-center justify-center hover:opacity-90 active:scale-95 transition-all focus:outline-none focus-visible:ring-2 focus-visible:ring-secondary/30"
            >
              <Avatar src={profile?.avatar} displayName={profile?.displayName} size="md" ring="status" statusVariant={statusVariant} decorative />
            </button>
          </div>
        </div>
      </div>
      <UpdateBanner update={update} onDismiss={onDismissUpdate} />
    </nav>
  )
}
