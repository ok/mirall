// Every screen the app can be on, and the one it backs out to. This table IS the screen graph: the
// router renders from it and `goBack` walks it, so the set of screens is enumerated once rather
// than once per switch.
//
// A string parent is fixed. A function reads the target the screen remembered on its way in —
// Settings returns to the space it was opened from rather than always to the home screen, and the
// activity log and its settings back out to whichever screen cross-linked into them.
export interface BackTargets {
  preSettingsScreen: 'spaces' | 'space-view'
  preAccountScreen: 'spaces' | 'space-view'
  storageBackTarget: 'settings' | 'space-view'
  backupBackTarget: 'settings' | 'account'
  activityLogBackTarget: Screen
  activityLogSettingsBackTarget: 'settings' | 'storage-settings'
}

const PARENT = {
  // The root. Backing out of it is the one case with nowhere to go.
  spaces: null,
  'space-view': 'spaces',
  'folder-view': 'space-view',
  settings: (t: BackTargets) => t.preSettingsScreen,
  account: (t: BackTargets) => t.preAccountScreen,
  'storage-settings': (t: BackTargets) => t.storageBackTarget,
  'backup-settings': (t: BackTargets) => t.backupBackTarget,
  'appearance-settings': 'settings',
  'notification-settings': 'settings',
  'general-settings': 'settings',
  'network-settings': 'settings',
  'network-status': 'account',
  'network-diagnostics': 'network-status',
  'network-advanced': 'network-status',
  'activity-log': (t: BackTargets) => t.activityLogBackTarget,
  'activity-log-settings': (t: BackTargets) => t.activityLogSettingsBackTarget,
  'connection-problem': 'spaces',
} as const

export type Screen = keyof typeof PARENT

/** @internal the back-terminates invariant's list; production routes by name, never over all screens */
export const SCREENS = Object.keys(PARENT) as Screen[]

// The screen to go back to, or null at the root.
export function parentOf(screen: Screen, targets: BackTargets): Screen | null {
  const parent: Screen | null | ((t: BackTargets) => Screen) = PARENT[screen]
  return typeof parent === 'function' ? parent(targets) : parent
}
