import type { AppNavigation } from '../../hooks/useAppNavigation.js'
import type { Profile } from '../../types.js'
import SharedSpaces from '../../screens/SharedSpaces.js'
import SpaceView from '../../screens/SpaceView.js'
import FolderView from '../../screens/FolderView.js'
import Settings from '../../screens/Settings.js'
import StorageSettings from '../../screens/StorageSettings.js'
import AboutSettings from '../../screens/AboutSettings.js'
import NotificationSettings from '../../screens/NotificationSettings.js'
import AppearanceSettings from '../../screens/AppearanceSettings.js'
import GeneralSettings from '../../screens/GeneralSettings.js'
import NetworkStatus from '../../screens/NetworkStatus.js'
import Account from '../../screens/Account.js'
import ActivityLog from '../../screens/ActivityLog.js'
import ActivityLogSettings from '../../screens/ActivityLogSettings.js'

interface ScreenRouterProps {
  nav: AppNavigation
  profile: Profile | null
  onSaveProfile: (data: { displayName: string; avatar: string | null }) => Promise<Profile>
  onOpenFeedback: () => void
  onShowCreate: () => void
  onShowJoin: () => void
}

export default function ScreenRouter({ nav, profile, onSaveProfile, onOpenFeedback, onShowCreate, onShowJoin }: ScreenRouterProps) {
  const { currentScreen, selectedSpaceId, selectedShare } = nav
  switch (currentScreen) {
    case 'spaces':
      return (
        <SharedSpaces
          onSelectSpace={nav.navigateToSpace}
          onShowCreate={onShowCreate}
          onShowJoin={onShowJoin}
        />
      )
    case 'space-view':
      return selectedSpaceId ? (
        <SpaceView
          spaceId={selectedSpaceId}
          onBack={() => nav.setCurrentScreen('spaces')}
          onManageStorage={() => nav.openStorageSettings('space-view')}
          onOpenShare={(share) => {
            nav.setSelectedShare(share)
            nav.setCurrentScreen('folder-view')
          }}
        />
      ) : null
    case 'folder-view':
      return selectedSpaceId && selectedShare ? (
        <FolderView
          spaceId={selectedSpaceId}
          share={selectedShare}
          onBack={() => {
            nav.setSelectedShare(null)
            nav.setCurrentScreen('space-view')
          }}
          onMirror={(share) => {
            nav.setSelectedShare(null)
            nav.setCurrentScreen('space-view')
            window.setTimeout(() => {
              window.dispatchEvent(new CustomEvent('mirall:open-mirror-modal', { detail: share }))
            }, 0)
          }}
          onUnmounted={() => nav.setSelectedShare((s) => (s ? { ...s, role: 'browse', mirrorEnabled: undefined, mountStatus: undefined } : s))}
        />
      ) : null
    case 'settings':
      return (
        <Settings
          onBack={() => nav.setCurrentScreen(nav.preSettingsScreen)}
          onNavigate={(screen) => {
            if (screen === 'storage-settings') nav.openStorageSettings('settings')
            else nav.setCurrentScreen(screen)
          }}
        />
      )
    case 'account':
      return (
        <Account
          profile={profile}
          onSave={onSaveProfile}
          onBack={() => nav.setCurrentScreen(nav.preAccountScreen)}
          onOpenNetworkStatus={() => nav.setCurrentScreen('network-status')}
          onOpenActivityLog={nav.openActivityLog}
        />
      )
    case 'storage-settings':
      return <StorageSettings onBack={() => nav.setCurrentScreen(nav.storageBackTarget)} />
    case 'about':
      return <AboutSettings onBack={() => nav.setCurrentScreen(nav.preAboutScreen)} onFeedback={onOpenFeedback} />
    case 'appearance-settings':
      return <AppearanceSettings onBack={() => nav.setCurrentScreen('settings')} />
    case 'notification-settings':
      return <NotificationSettings onBack={() => nav.setCurrentScreen('settings')} />
    case 'general-settings':
      return <GeneralSettings onBack={() => nav.setCurrentScreen('settings')} />
    case 'network-status':
      return <NetworkStatus onBack={() => nav.setCurrentScreen('account')} />
    case 'activity-log':
      return (
        <ActivityLog
          onBack={() => nav.setCurrentScreen('account')}
          onOpenSettings={nav.openActivityLogSettings}
        />
      )
    case 'activity-log-settings':
      return (
        <ActivityLogSettings
          onBack={() => nav.setCurrentScreen('settings')}
          onOpenLog={nav.openActivityLog}
        />
      )
    default:
      return null
  }
}
