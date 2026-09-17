import type { AppNavigation } from './hooks/useAppNavigation.js'
import type { Screen } from './shell/navigation.js'
import type { AppDialog } from './components/modals/AppDialogs.js'
import type { Profile } from './types/types.js'
import SpacesScreen from './screens/SpacesScreen.js'
import SpaceScreen from './screens/SpaceScreen.js'
import FolderScreen from './screens/FolderScreen.js'
import Settings from './screens/settings/SettingsScreen.js'
import StorageSettings from './screens/settings/StorageSettings.js'
import NotificationSettings from './screens/settings/NotificationSettings.js'
import AppearanceSettings from './screens/settings/AppearanceSettings.js'
import GeneralSettings from './screens/settings/GeneralSettings.js'
import NetworkSettings from './screens/settings/NetworkSettings.js'
import NetworkStatusScreen from './screens/NetworkStatusScreen.js'
import NetworkDiagnosticsScreen from './screens/NetworkDiagnosticsScreen.js'
import NetworkAdvancedScreen from './screens/NetworkAdvancedScreen.js'
import Account from './screens/AccountScreen.js'
import ActivityLog from './screens/ActivityLogScreen.js'
import ActivityLogSettings from './screens/settings/ActivityLogSettings.js'
import ConnectionProblemScreen from './screens/ConnectionProblemScreen.js'
import { useConnectionGate } from './hooks/useConnectionGate.js'
import { useShares } from './hooks/useShares.js'
import { folderRouteState } from './model/folder-route-state.js'
import { useEffect } from 'react'

interface ScreenRouterProps {
  nav: AppNavigation
  profile: Profile | null
  onSaveProfile: (data: { displayName: string; avatar: string | null }) => Promise<Profile>
  openDialog: (dialog: AppDialog) => void
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
  const state = folderRouteState({ found: share !== null, loading })
  const missing = state === 'missing'
  useEffect(() => {
    // Deleted under us, or the space was left: there is no folder to show, so leave the screen
    // rather than hold an empty one.
    if (missing) nav.goBack()
  }, [missing, nav])
  if (!share || state !== 'show') return null
  return (
    // Keyed, so a folder is a fresh mount rather than a reused instance carrying the previous one's
    // fold, expansion snapshot and filter. Load-bearing: useShareFiles, useTreeExpansion and
    // FolderScreen's preFilterRef all assume a mount per share, and a re-target without this key
    // unions one folder's rows into another's first incomplete listing, silently.
    <FolderScreen
      key={share.id}
      spaceId={spaceId}
      share={share}
      onBack={nav.goBack}
      onMirror={(s) => nav.requestMirror(s.id)}
    />
  )
}

// Network status and the two screens below it. They share one rule — both children back out to
// Network status, never to the screen it was opened from — so they route together.
const NETWORK_SCREENS = ['network-status', 'network-diagnostics', 'network-advanced'] as const

type NetworkScreen = (typeof NETWORK_SCREENS)[number]

function isNetworkScreen(screen: Screen): screen is NetworkScreen {
  return (NETWORK_SCREENS as readonly Screen[]).includes(screen)
}

function networkRoute(screen: NetworkScreen, nav: AppNavigation) {
  const toStatus = () => nav.setCurrentScreen('network-status')
  switch (screen) {
    case 'network-status':
      return (
        <NetworkStatusScreen
          onBack={() => nav.setCurrentScreen('account')}
          onShowHistory={() => nav.openActivityLog({ categories: ['network'] })}
          onOpenSettings={() => nav.setCurrentScreen('network-settings')}
          onOpenDiagnostics={() => nav.setCurrentScreen('network-diagnostics')}
          onOpenAdvanced={() => nav.setCurrentScreen('network-advanced')}
        />
      )
    case 'network-diagnostics':
      return <NetworkDiagnosticsScreen onBack={toStatus} />
    case 'network-advanced':
      return <NetworkAdvancedScreen onBack={toStatus} />
  }
}

export default function ScreenRouter({ nav, profile, onSaveProfile, openDialog }: ScreenRouterProps) {
  const { currentScreen, selectedSpaceId, selectedShareId } = nav
  const gate = useConnectionGate()
  if (isNetworkScreen(currentScreen)) return networkRoute(currentScreen, nav)
  switch (currentScreen) {
    case 'spaces':
      return gate.showConnectionProblem ? (
        <ConnectionProblemScreen
          onContinue={gate.dismiss}
          onShowDetails={() => nav.setCurrentScreen('network-status')}
          onShowHistory={() => nav.openActivityLog({ categories: ['network'] })}
        />
      ) : (
        <SpacesScreen
          onSelectSpace={nav.navigateToSpace}
          onShowCreate={() => openDialog({ kind: 'create' })}
          onShowJoin={() => openDialog({ kind: 'join' })}
        />
      )
    case 'connection-problem':
      return (
        <ConnectionProblemScreen
          onBack={() => nav.setCurrentScreen('spaces')}
          onContinue={() => nav.setCurrentScreen('spaces')}
          onShowDetails={() => nav.setCurrentScreen('network-status')}
          onShowHistory={() => nav.openActivityLog({ categories: ['network'] })}
        />
      )
    case 'space-view':
      return selectedSpaceId ? (
        <SpaceScreen
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
          onFeedback={() => openDialog({ kind: 'feedback' })}
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
      return (
        <NetworkSettings
          onBack={() => nav.setCurrentScreen('settings')}
          onOpenStatus={() => nav.setCurrentScreen('network-status')}
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
