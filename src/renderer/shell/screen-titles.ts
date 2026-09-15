import type { Screen } from './navigation.js'

// The name a screen is announced by when it becomes current. Exhaustive over the screen graph: a
// screen added to navigation.ts without a row here is a compile error, not a silent blank.
export const SCREEN_TITLE_KEYS: Record<Screen, string> = {
  'spaces': 'a11y.screens.spaces',
  'space-view': 'a11y.screens.spaceView',
  'folder-view': 'a11y.screens.folderView',
  'settings': 'a11y.screens.settings',
  'account': 'a11y.screens.account',
  'storage-settings': 'a11y.screens.storage',
  'appearance-settings': 'a11y.screens.appearance',
  'notification-settings': 'a11y.screens.notifications',
  'general-settings': 'a11y.screens.general',
  'network-settings': 'a11y.screens.networkSettings',
  'network-status': 'a11y.screens.network',
  'connection-problem': 'a11y.screens.connectionProblem',
  'activity-log': 'a11y.screens.activityLog',
  'activity-log-settings': 'a11y.screens.activityLogSettings',
}
