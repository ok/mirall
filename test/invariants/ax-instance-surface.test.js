import test from 'brittle'
import { Instance } from '../frontend/instance.mjs'

// The split is a move, not a redesign: 135 scenarios call this surface, and a method silently lost
// to a mixin would fail deep inside a GUI run rather than here.
const SURFACE = [
  'launch', 'kill', 'quit', 'relaunch',
  'snap', 'click', 'hover', 'type', 'setRaw', 'focus', 'press',
  'waitText', 'hasText', 'isChecked', 'nodeValue', 'isDisabled', 'has',
  'clipboard', 'copyFrom', 'shot',
  'onboard', 'createSpaceOnly', 'openSettings', 'gotoSettings', 'openAccount', 'openNetworkStatus',
  'openActivityLog', 'openJoinModal', 'openInviteModal', 'openEditSpace', 'back', 'nativeChoosePath',
  'addFile', 'addOwnedFolder', 'openAddFolderModal', 'openAddFolderPreview', 'openAddFolderAndPick',
  'mirrorShare', 'openMirrorPreview', 'unmountShare', 'deleteShare', 'pauseMirror', 'resumeMirror',
  'openFolder', 'openManageStorage', 'leaveSpace',
]

test('Instance keeps its whole surface across the three files', (t) => {
  for (const name of SURFACE) t.is(typeof Instance.prototype[name], 'function', `Instance#${name}`)
})
