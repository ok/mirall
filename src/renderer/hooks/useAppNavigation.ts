import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ShareWithRole } from './useShares.js'

export interface AppNavigation {
  currentScreen: string
  selectedSpaceId: string | null
  selectedShare: ShareWithRole | null
  preSettingsScreen: 'spaces' | 'space-view'
  preAccountScreen: 'spaces' | 'space-view'
  preAboutScreen: 'spaces' | 'space-view' | 'settings'
  storageBackTarget: 'settings' | 'space-view'
  setCurrentScreen: Dispatch<SetStateAction<string>>
  setSelectedSpaceId: Dispatch<SetStateAction<string | null>>
  setSelectedShare: Dispatch<SetStateAction<ShareWithRole | null>>
  navigateToSpace: (spaceId: string) => void
  openSettings: () => void
  openAccount: () => void
  openAbout: () => void
  openStorageSettings: (from: 'settings' | 'space-view') => void
  goBack: () => void
  goHome: () => void
  resetToRoot: () => void
}

export function useAppNavigation(): AppNavigation {
  const [currentScreen, setCurrentScreen] = useState('spaces')
  const [preSettingsScreen, setPreSettingsScreen] = useState<'spaces' | 'space-view'>('spaces')
  const [preAccountScreen, setPreAccountScreen] = useState<'spaces' | 'space-view'>('spaces')
  const [preAboutScreen, setPreAboutScreen] = useState<'spaces' | 'space-view' | 'settings'>('settings')
  const [storageBackTarget, setStorageBackTarget] = useState<'settings' | 'space-view'>('settings')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [selectedShare, setSelectedShare] = useState<ShareWithRole | null>(null)

  const openSettings = useCallback(() => {
    setPreSettingsScreen((prev) => {
      if (currentScreen === 'spaces' || currentScreen === 'space-view') return currentScreen
      return prev
    })
    setCurrentScreen('settings')
  }, [currentScreen])

  const openAccount = useCallback(() => {
    setPreAccountScreen((prev) => {
      if (currentScreen === 'spaces' || currentScreen === 'space-view') return currentScreen
      return prev
    })
    setCurrentScreen('account')
  }, [currentScreen])

  const openAbout = useCallback(() => {
    if (currentScreen === 'spaces' || currentScreen === 'space-view' || currentScreen === 'settings') {
      setPreAboutScreen(currentScreen)
    }
    setCurrentScreen('about')
  }, [currentScreen])

  const openStorageSettings = useCallback((from: 'settings' | 'space-view') => {
    setStorageBackTarget(from)
    setCurrentScreen('storage-settings')
  }, [])

  const navigateToSpace = useCallback((spaceId: string) => {
    setSelectedSpaceId(spaceId)
    setCurrentScreen('space-view')
  }, [])

  // Single source of truth for "go up one screen", mirroring each screen's
  // on-screen back button. Wired to the OS-level back affordances (mouse back
  // button, Windows browser-backward app-command, macOS swipe, mod+←) so they
  // behave like a browser back button. 'spaces' is the root — nothing above it.
  const goBack = useCallback(() => {
    switch (currentScreen) {
      case 'space-view': setCurrentScreen('spaces'); break
      case 'folder-view': setSelectedShare(null); setCurrentScreen('space-view'); break
      case 'settings': setCurrentScreen(preSettingsScreen); break
      case 'account': setCurrentScreen(preAccountScreen); break
      case 'storage-settings': setCurrentScreen(storageBackTarget); break
      case 'about': setCurrentScreen(preAboutScreen); break
      case 'appearance-settings':
      case 'notification-settings':
      case 'general-settings': setCurrentScreen('settings'); break
      case 'network-status': setCurrentScreen('account'); break
      default: break
    }
  }, [currentScreen, preSettingsScreen, preAccountScreen, preAboutScreen, storageBackTarget])

  const goHome = useCallback(() => {
    setSelectedShare(null)
    setSelectedSpaceId(null)
    setCurrentScreen('spaces')
  }, [])

  const resetToRoot = useCallback(() => {
    setCurrentScreen('spaces')
    setPreSettingsScreen('spaces')
    setSelectedSpaceId(null)
  }, [])

  return {
    currentScreen,
    selectedSpaceId,
    selectedShare,
    preSettingsScreen,
    preAccountScreen,
    preAboutScreen,
    storageBackTarget,
    setCurrentScreen,
    setSelectedSpaceId,
    setSelectedShare,
    navigateToSpace,
    openSettings,
    openAccount,
    openAbout,
    openStorageSettings,
    goBack,
    goHome,
    resetToRoot,
  }
}
