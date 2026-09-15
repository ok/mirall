// Root: the boot gate (loading → onboarding → shell), then the shell that composes providers,
// bridges, global dialogs, commands and the screen router.
import { useState, useEffect, useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { useProfile } from './hooks/useProfile.js'
import { useUpdates } from './hooks/useUpdates.js'
import { useSpaces } from './hooks/useSpaces.js'
import { useAppNavigation, type AppNavigation } from './hooks/useAppNavigation.js'
import { useAppShellEffects } from './hooks/useAppShellEffects.js'
import { useAppCommands } from './hooks/useAppCommands.js'
import { useSpaceCommands } from './hooks/useSpaceCommands.js'
import { useCanGoBack } from './hooks/useCanGoBack.js'
import { useDeepLinkQueue, useDeepLinkRouter, type DeepLinkQueue } from './hooks/useDeepLinks.js'
import { useRouteAnnouncer } from './hooks/useRouteAnnouncer.js'
import { useSkipLinkFocusGuard } from './hooks/useSkipLinkFocusGuard.js'
import { useNotificationClickRouter } from './notifications/click-router.js'
import { checkChangelogOnBoot } from './platform/changelog.js'
import * as whatsNew from './platform/whats-new.js'
import OnboardingScreen from './screens/OnboardingScreen.js'
import ScreenRouter from './ScreenRouter.js'
import TopNav from './components/layout/TopNav.js'
import AppDialogs, { type AppDialog } from './components/modals/AppDialogs.js'
import { KeyboardProvider } from './keyboard/KeyboardProvider.js'
import CommandPalette from './keyboard/CommandPalette.js'
import ShortcutsHint from './keyboard/ShortcutsHint.js'
import { ToastProvider } from './components/toast/ToastProvider.js'
import { ConnectionStatusProvider } from './hooks/useConnectionStatus.js'
import ConnectivityToastBridge from './components/toast/bridges/ConnectivityToastBridge.js'
import WorkerToastBridge from './components/toast/bridges/WorkerToastBridge.js'
import DownloadFolderToastBridge from './components/toast/bridges/DownloadFolderToastBridge.js'
import JoinRequestToastBridge from './components/toast/bridges/JoinRequestToastBridge.js'
import type { Profile } from './types/types.js'

export default function App() {
  const { t } = useTranslation()
  const { profile, needsSetup, loading, saveProfile } = useProfile()
  const { spaces } = useSpaces()
  const nav = useAppNavigation()
  const deepLinks = useDeepLinkQueue()

  useAppShellEffects(spaces)

  useEffect(() => {
    if (loading) return
    checkChangelogOnBoot(!needsSetup).then((entries) => {
      if (entries) whatsNew.open(entries)
    })
  }, [loading, needsSetup])

  if (loading) return (
    <main className="min-h-screen bg-surface flex items-center justify-center">
      <h1 className="sr-only">{t('boot.loading')}</h1>
      <p role="status" className="text-on-surface text-lg">{t('boot.loading')}</p>
    </main>
  )
  if (needsSetup) return <OnboardingScreen onComplete={saveProfile} />

  return (
    <ToastProvider>
      <ConnectionStatusProvider>
        <KeyboardProvider currentScreen={nav.currentScreen} selectedSpaceId={nav.selectedSpaceId}>
          <AppShell nav={nav} profile={profile} onSaveProfile={saveProfile} deepLinks={deepLinks} />
        </KeyboardProvider>
      </ConnectionStatusProvider>
    </ToastProvider>
  )
}

interface AppShellProps {
  nav: AppNavigation
  profile: Profile | null
  onSaveProfile: (data: { displayName: string; avatar: string | null }) => Promise<Profile>
  deepLinks: DeepLinkQueue
}

function AppShell({ nav, profile, onSaveProfile, deepLinks }: AppShellProps) {
  const { t } = useTranslation()
  const { spaces, loading: spacesLoading, createSpace, joinSpace, toggleFavorite } = useSpaces()
  const { update, dismissed, dismiss } = useUpdates()
  const [dialog, setDialog] = useState<AppDialog | null>(null)
  const closeDialog = useCallback(() => setDialog(null), [])
  const canGoBack = useCanGoBack(nav.currentScreen)
  const { mainRef, announcement } = useRouteAnnouncer(nav.currentScreen)
  const onSkipLinkFocus = useSkipLinkFocusGuard()

  useAppCommands({ nav, spaces, canGoBack, openDialog: setDialog })
  useSpaceCommands({ nav, spaces, toggleFavorite })
  useDeepLinkRouter({ queue: deepLinks, spaces, navigateToSpace: nav.navigateToSpace, openDialog: setDialog })
  useNotificationClickRouter(nav.navigateToSpace)

  // If the space we're viewing vanishes (e.g. a pending join was denied and the worker dropped it),
  // don't leave the user staring at a dead view.
  useEffect(() => {
    if (spacesLoading) return
    if (nav.currentScreen === 'space-view' && nav.selectedSpaceId && !spaces.some((s) => s.spaceId === nav.selectedSpaceId)) {
      nav.goHome()
    }
  }, [spacesLoading, nav.currentScreen, nav.selectedSpaceId, spaces, nav.goHome])

  useEffect(() => {
    return window.bridge.onHiddenToTray(() => {
      nav.resetToRoot()
      setDialog(null)
    })
  }, [nav.resetToRoot])

  // The space list rides along because the native menu owns the ⌘1-9 chords: macOS resolves a menu
  // key equivalent before Chromium's own digit accelerators, which otherwise swallow them before the
  // webContents ever sees the key.
  useEffect(() => {
    window.bridge.menuContextChanged({
      inSpace: nav.currentScreen === 'space-view' || nav.currentScreen === 'folder-view',
      spaces: spaces.slice(0, 9).map((s) => ({ id: s.spaceId, name: s.name })),
    }).catch((err) => console.error('menuContextChanged failed:', err))
  }, [nav.currentScreen, spaces])

  return (
    <>
      <ConnectivityToastBridge onShowDetails={() => nav.setCurrentScreen('network-status')} onShowHelp={() => nav.setCurrentScreen('connection-problem')} />
      <DownloadFolderToastBridge onChangeFolder={() => nav.openStorageSettings(nav.currentScreen === 'space-view' ? 'space-view' : 'settings')} />
      <WorkerToastBridge />
      <JoinRequestToastBridge navigateToSpace={nav.navigateToSpace} />
      <div className="min-h-screen bg-surface">
        <a
          href="#main-content"
          onFocus={onSkipLinkFocus}
          className="sr-only focus:not-sr-only focus:fixed focus:z-[100] focus:top-4 focus:left-4 focus:px-4 focus:py-2 focus:rounded-lg focus:bg-primary focus:text-on-primary focus:shadow-lg"
        >
          {t('a11y.skipToContent')}
        </a>
        <div aria-live="polite" className="sr-only">{announcement}</div>
        <TopNav
          profile={profile}
          onLogoClick={nav.goHome}
          onSettingsClick={nav.openSettings}
          onAccountClick={nav.openAccount}
          onFeedbackClick={() => setDialog({ kind: 'feedback' })}
          update={dismissed ? null : update}
          onDismissUpdate={dismiss}
        />
        <AppDialogs
          dialog={dialog}
          onClose={closeDialog}
          onCreate={createSpace}
          onJoin={joinSpace}
          onEntered={nav.navigateToSpace}
        />
        <CommandPalette />
        <ShortcutsHint />
        <main id="main-content" ref={mainRef} tabIndex={-1} className="pt-[calc(5rem+var(--banner-h,0px))] focus:outline-none">
          <ScreenRouter nav={nav} profile={profile} onSaveProfile={onSaveProfile} openDialog={setDialog} />
        </main>
      </div>
    </>
  )
}
