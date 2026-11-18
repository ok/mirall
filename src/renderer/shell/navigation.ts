// Every screen the app can be on, and the one it backs out to. This table IS the screen graph: the
// router renders from it and `goBack` walks it, so the set of screens is enumerated once rather
// than once per switch.
//
// A string parent is fixed. A function reads the target the screen remembered on its way in —
// Settings returns to the space it was opened from rather than always to the home screen, and the
// activity log, its settings and the transfers page back out to whichever screen opened them, and a
// settings page opened from the Organization page backs out to it.
export interface BackTargets {
  preSettingsScreen: 'spaces' | 'space-view'
  preAccountScreen: 'spaces' | 'space-view'
  storageBackTarget: 'settings' | 'space-view'
  activityLogBackTarget: Screen
  activityLogSettingsBackTarget: 'settings' | 'storage-settings' | 'organization'
  settingsPageBackTarget: 'settings' | 'organization'
  transfersBackTarget: Screen
}

const PARENT = {
  // The root. Backing out of it is the one case with nowhere to go.
  spaces: null,
  'space-view': 'spaces',
  'folder-view': 'space-view',
  settings: (t: BackTargets) => t.preSettingsScreen,
  account: (t: BackTargets) => t.preAccountScreen,
  'storage-settings': (t: BackTargets) => t.storageBackTarget,
  'backup-settings': (t: BackTargets) => t.settingsPageBackTarget,
  'appearance-settings': 'settings',
  'notification-settings': 'settings',
  'general-settings': 'settings',
  'network-settings': (t: BackTargets) => t.settingsPageBackTarget,
  'network-status': 'account',
  about: 'account',
  organization: 'about',
  'network-diagnostics': 'network-status',
  'network-advanced': 'network-status',
  'activity-log': (t: BackTargets) => t.activityLogBackTarget,
  'activity-log-settings': (t: BackTargets) => t.activityLogSettingsBackTarget,
  transfers: (t: BackTargets) => t.transfersBackTarget,
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

// Whether backing out of `from` passes through `via`. Two screens that each remember where they
// were opened from must not remember each other: Back would then alternate between them and never
// reach the root, so the one opened second keeps the target it already had.
export function backsThrough(from: Screen, via: Screen, targets: BackTargets): boolean {
  const seen = new Set<Screen>()
  let at: Screen | null = from
  while (at && !seen.has(at)) {
    if (at === via) return true
    seen.add(at)
    at = parentOf(at, targets)
  }
  return false
}
