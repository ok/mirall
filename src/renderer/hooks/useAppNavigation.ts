import { useCallback, useState } from 'react'
import type { Dispatch, SetStateAction } from 'react'
import type { ShareWithRole } from './useShares.js'
import type { AuditFilters } from '../types.js'
import { parentOf, type Screen } from '../navigation.js'

export interface AppNavigation {
  currentScreen: Screen
  selectedSpaceId: string | null
  selectedShare: ShareWithRole | null
  preSettingsScreen: 'spaces' | 'space-view'
  preAccountScreen: 'spaces' | 'space-view'
  storageBackTarget: 'settings' | 'space-view'
  activityLogPreset: Partial<AuditFilters> | null
  setCurrentScreen: Dispatch<SetStateAction<Screen>>
  setSelectedShare: Dispatch<SetStateAction<ShareWithRole | null>>
  navigateToSpace: (spaceId: string) => void
  openSettings: () => void
  openAccount: () => void
  openStorageSettings: (from: 'settings' | 'space-view') => void
  openActivityLog: (preset?: Partial<AuditFilters> | null) => void
  openActivityLogSettings: () => void
  goBack: () => void
  goHome: () => void
  resetToRoot: () => void
}

export function useAppNavigation(): AppNavigation {
  const [currentScreen, setCurrentScreen] = useState<Screen>('spaces')
  const [preSettingsScreen, setPreSettingsScreen] = useState<'spaces' | 'space-view'>('spaces')
  const [preAccountScreen, setPreAccountScreen] = useState<'spaces' | 'space-view'>('spaces')
  const [storageBackTarget, setStorageBackTarget] = useState<'settings' | 'space-view'>('settings')
  const [selectedSpaceId, setSelectedSpaceId] = useState<string | null>(null)
  const [selectedShare, setSelectedShare] = useState<ShareWithRole | null>(null)
  const [activityLogPreset, setActivityLogPreset] = useState<Partial<AuditFilters> | null>(null)
  // The viewer hangs off Account, but the connectivity screens now cross-link into it too, so Back
  // has to return where the user came from rather than always to Account.
  const [activityLogBackTarget, setActivityLogBackTarget] = useState<Screen>('account')

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

  const openStorageSettings = useCallback((from: 'settings' | 'space-view') => {
    setStorageBackTarget(from)
    setCurrentScreen('storage-settings')
  }, [])

  const openActivityLog = useCallback((preset: Partial<AuditFilters> | null = null) => {
    setActivityLogPreset(preset)
    // The viewer/config cross-link stays a lateral jump, not a history step: following it and
    // pressing Back returns to THAT screen's own parent, which is the shipped convention.
    const lateral = currentScreen === 'activity-log' || currentScreen === 'activity-log-settings'
    setActivityLogBackTarget(lateral ? 'account' : currentScreen)
    setCurrentScreen('activity-log')
  }, [currentScreen])
  const openActivityLogSettings = useCallback(() => setCurrentScreen('activity-log-settings'), [])

  const navigateToSpace = useCallback((spaceId: string) => {
    setSelectedSpaceId(spaceId)
    setCurrentScreen('space-view')
  }, [])

  // Single source of truth for "go up one screen", mirroring each screen's
  // on-screen back button. Wired to the OS-level back affordances (mouse back
  // button, Windows browser-backward app-command, macOS swipe, mod+←) so they
  // behave like a browser back button. 'spaces' is the root — nothing above it.
  const goBack = useCallback(() => {
    const parent = parentOf(currentScreen, {
      preSettingsScreen, preAccountScreen, storageBackTarget, activityLogBackTarget,
    })
    if (!parent) return
    // The folder screen's share is a snapshot the router holds; leaving the screen is what makes it
    // stale, so it goes at the same moment the screen does.
    if (currentScreen === 'folder-view') setSelectedShare(null)
    setCurrentScreen(parent)
  }, [currentScreen, preSettingsScreen, preAccountScreen, storageBackTarget, activityLogBackTarget])

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
    storageBackTarget,
    activityLogPreset,
    setCurrentScreen,
    setSelectedShare,
    navigateToSpace,
    openSettings,
    openAccount,
    openStorageSettings,
    openActivityLog,
    openActivityLogSettings,
    goBack,
    goHome,
    resetToRoot,
  }
}
