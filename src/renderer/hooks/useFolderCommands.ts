// The folder screen's palette entries, registered while FolderView is mounted and unregistered
// with it. That mount lifetime IS the scoping: the folder screen is the only place FolderView
// renders, so "this folder" in a label can only ever mean the folder on screen, and the command
// context never has to carry a share id. Which entries are offered, and under which label, is
// decided by deriveFolderCommands; this hook only binds them to the screen's handlers.
import { useRegisterCommand } from '../keyboard/KeyboardProvider.js'
import { deriveFolderCommands } from '../folderCommands.js'
import type { ShareRole } from '../types.js'

export interface FolderCommandsArgs {
  name: string
  role: ShareRole
  paused: boolean
  sourceMissing: boolean
  canMirror: boolean
  onOpen: () => void
  onLocate: () => void
  onSetPaused: (paused: boolean) => void
  onMirror: () => void
  onEdit: () => void
}

// Every label and availability value appears in its command's dependency list, not just the ones
// the closure reads: useRegisterCommand freezes labelKey at registration time, and the provider
// only re-filters the palette when a register/unregister bumps its version. A predicate that
// quietly changed its answer would leave a stale row in an already-open palette.
export function useFolderCommands({
  name,
  role,
  paused,
  sourceMissing,
  canMirror,
  onOpen,
  onLocate,
  onSetPaused,
  onMirror,
  onEdit,
}: FolderCommandsArgs): void {
  const spec = deriveFolderCommands({ role, paused, sourceMissing, canMirror })
  const labelParams = { name }

  useRegisterCommand(
    {
      id: 'folder.open',
      labelKey: spec.open.labelKey,
      labelParams,
      group: 'space',
      when: () => spec.open.available,
      run: onOpen,
    },
    [name, spec.open.labelKey, spec.open.available],
  )
  useRegisterCommand(
    {
      id: 'folder.locate',
      labelKey: spec.locate.labelKey,
      labelParams,
      group: 'space',
      when: () => spec.locate.available,
      run: onLocate,
    },
    [name, spec.locate.labelKey, spec.locate.available],
  )
  useRegisterCommand(
    {
      id: 'folder.toggleSync',
      labelKey: spec.toggleSync.labelKey,
      labelParams,
      group: 'space',
      when: () => spec.toggleSync.available,
      run: () => onSetPaused(!paused),
    },
    [name, spec.toggleSync.labelKey, spec.toggleSync.available],
  )
  useRegisterCommand(
    {
      id: 'folder.mirror',
      labelKey: spec.mirror.labelKey,
      labelParams,
      group: 'space',
      when: () => spec.mirror.available,
      run: onMirror,
    },
    [name, spec.mirror.labelKey, spec.mirror.available],
  )
  useRegisterCommand(
    {
      id: 'folder.edit',
      labelKey: spec.edit.labelKey,
      labelParams,
      group: 'space',
      when: () => spec.edit.available,
      run: onEdit,
    },
    [name, spec.edit.labelKey, spec.edit.available],
  )
}
