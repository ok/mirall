import type { AppNavigation } from './hooks/useAppNavigation.js'
import type { Profile } from './types.js'
import SharedSpaces from './screens/SharedSpaces.js'
import SpaceView from './screens/SpaceView.js'
import FolderView from './screens/FolderView.js'
import Settings from './screens/settings/Settings.js'
import StorageSettings from './screens/settings/StorageSettings.js'
import NotificationSettings from './screens/settings/NotificationSettings.js'
import AppearanceSettings from './screens/settings/AppearanceSettings.js'
import GeneralSettings from './screens/settings/GeneralSettings.js'
import NetworkSettings from './screens/settings/NetworkSettings.js'
import NetworkStatus from './screens/NetworkStatus.js'
import Account from './screens/Account.js'
import ActivityLog from './screens/ActivityLog.js'
import ActivityLogSettings from './screens/settings/ActivityLogSettings.js'
import ConnectionProblem from './screens/ConnectionProblem.js'
import { useConnectionGate } from './hooks/useConnectionGate.js'
import { useShares } from './hooks/useShares.js'
import { useEffect } from 'react'

interface ScreenRouterProps {
  nav: AppNavigation
  profile: Profile | null
  onSaveProfile: (data: { displayName: string; avatar: string | null }) => Promise<Profile>
  onOpenFeedback: () => void
  onShowCreate: () => void
  onShowJoin: () => void
}

// The folder screen reads its folder from the live listing rather than from the row that was
// clicked. A snapshot of that row goes stale the moment the folder is renamed or unmounted, which
// is why the router used to spread corrections back into it by hand.
function FolderViewRoute({ nav, profile, spaceId, shareId }: {
  nav: AppNavigation
  profile: Profile | null
  spaceId: string
  shareId: string
}) {
  const { shares, loading } = useShares(spaceId, profile?.publicKey ?? null)
  const share = shares.find((s) => s.id === shareId) ?? null
  const missing = !share && !loading
  useEffect(() => {
    // Deleted under us, or the space was left: there is no folder to show, so leave the screen
    // rather than hold an empty one.
    if (missing) nav.goBack()
  }, [missing, nav])
  if (!share) return null
  return (
    // Keyed, so a folder is a fresh mount rather than a reused instance carrying the previous one's
    // fold, expansion snapshot and filter. Load-bearing: useShareFiles, useTreeExpansion and
    // FolderView's preFilterRef all assume a mount per share, and a re-target without this key
    // unions one folder's rows into another's first incomplete listing, silently.
    <FolderView
      key={share.id}
      spaceId={spaceId}
      share={share}
      onBack={nav.goBack}
      onMirror={(s) => nav.requestMirror(s.id)}
    />
  )
}

export default function ScreenRouter({ nav, profile, onSaveProfile, onOpenFeedback, onShowCreate, onShowJoin }: ScreenRouterProps) {
  const { currentScreen, selectedSpaceId, selectedShareId } = nav
  const gate = useConnectionGate()
  switch (currentScreen) {
    case 'spaces':
      return gate.showConnectionProblem ? (
        <ConnectionProblem
          onContinue={gate.dismiss}
          onShowDetails={() => nav.setCurrentScreen('network-status')}
          onShowHistory={() => nav.openActivityLog({ categories: ['network'] })}
        />
      ) : (
        <SharedSpaces
          onSelectSpace={nav.navigateToSpace}
          onShowCreate={onShowCreate}
          onShowJoin={onShowJoin}
        />
      )
    case 'connection-problem':
      return (
        <ConnectionProblem
          onBack={() => nav.setCurrentScreen('spaces')}
          onContinue={() => nav.setCurrentScreen('spaces')}
          onShowDetails={() => nav.setCurrentScreen('network-status')}
          onShowHistory={() => nav.openActivityLog({ categories: ['network'] })}
        />
      )
    case 'space-view':
      return selectedSpaceId ? (
        <SpaceView
          spaceId={selectedSpaceId}
          pendingAction={nav.pendingSpaceAction}
          onActionConsumed={nav.clearPendingSpaceAction}
          onBack={() => nav.setCurrentScreen('spaces')}
          onManageStorage={() => nav.openStorageSettings('space-view')}
          onOpenShare={(share) => {
            nav.setSelectedShareId(share.id)
            nav.setCurrentScreen('folder-view')
          }}
        />
      ) : null
    case 'folder-view':
      return selectedSpaceId && selectedShareId ? (
        <FolderViewRoute
          nav={nav}
          profile={profile}
          spaceId={selectedSpaceId}
          shareId={selectedShareId}
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
          onOpenActivityLog={() => nav.openActivityLog()}
          onFeedback={onOpenFeedback}
        />
      )
    case 'storage-settings':
      return <StorageSettings onBack={() => nav.setCurrentScreen(nav.storageBackTarget)} />
    case 'appearance-settings':
      return <AppearanceSettings onBack={() => nav.setCurrentScreen('settings')} />
    case 'notification-settings':
      return <NotificationSettings onBack={() => nav.setCurrentScreen('settings')} />
    case 'general-settings':
      return <GeneralSettings onBack={() => nav.setCurrentScreen('settings')} />
    case 'network-settings':
      return <NetworkSettings onBack={() => nav.setCurrentScreen('settings')} />
    case 'network-status':
      return (
        <NetworkStatus
          onBack={() => nav.setCurrentScreen('account')}
          onShowHistory={() => nav.openActivityLog({ categories: ['network'] })}
        />
      )
    case 'activity-log':
      return (
        <ActivityLog
          onBack={nav.goBack}
          onOpenSettings={nav.openActivityLogSettings}
          initialFilters={nav.activityLogPreset ?? undefined}
        />
      )
    case 'activity-log-settings':
      return (
        <ActivityLogSettings
          onBack={() => nav.setCurrentScreen('settings')}
          onOpenLog={() => nav.openActivityLog()}
        />
      )
  }
  // Every screen in the graph has a branch above, and TypeScript is what says so: a screen added to
  // `navigation.ts` with no case here fails to compile rather than rendering a blank window.
  const unrendered: never = currentScreen
  return unrendered
}
