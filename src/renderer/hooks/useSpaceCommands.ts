import { useKeyboard, useRegisterCommands } from '../keyboard/KeyboardProvider.js'
import { isInSpace, type CommandContext } from '../keyboard/registry.js'
import type { SpaceAction } from '../shell/space-actions.js'
import type { AppNavigation } from './useAppNavigation.js'
import type { Space } from '../types/types.js'
import { useRunAction } from './useRunAction.js'

interface SpaceCommandsArgs {
  nav: AppNavigation
  spaces: Space[]
  toggleFavorite: (spaceId: string) => Promise<void>
}

// Scoped to the space the user is in. A pending join is not a membership yet, so the member-only
// actions stay hidden until it lands; leaving is the one action a pending space keeps.
export function useSpaceCommands({ nav, spaces, toggleFavorite }: SpaceCommandsArgs): void {
  const { ctx } = useKeyboard()
  const runAction = useRunAction()
  const currentSpace = spaces.find((s) => s.spaceId === ctx.selectedSpaceId)
  const isPendingSpace = currentSpace?.status === 'pending'
  const isFavorite = currentSpace?.favorite === true
  const inJoinedSpace = (c: CommandContext) => isInSpace(c) && !isPendingSpace
  const act = (action: SpaceAction) => () => nav.requestSpaceAction(action)

  useRegisterCommands([
    { id: 'space.addFiles', labelKey: 'shortcuts.addFiles', group: 'space', when: inJoinedSpace, run: act('add-files') },
    { id: 'space.addFolder', labelKey: 'shortcuts.addFolder', group: 'space', when: inJoinedSpace, run: act('add-folder') },
    { id: 'space.invite', labelKey: 'shortcuts.invite', group: 'space', when: inJoinedSpace, run: act('invite') },
    { id: 'space.edit', labelKey: 'shortcuts.editSpace', group: 'space', when: inJoinedSpace, run: act('edit') },
    { id: 'space.leave', labelKey: 'shortcuts.leaveSpace', group: 'space', when: isInSpace, run: act('leave') },
    {
      id: 'space.favorite',
      labelKey: isFavorite ? 'shortcuts.removeFavorite' : 'shortcuts.addFavorite',
      group: 'space',
      when: inJoinedSpace,
      run: (c) => { const id = c.selectedSpaceId; if (id) runAction(() => toggleFavorite(id)) },
    },
    { id: 'space.manageStorage', labelKey: 'shortcuts.manageStorage', group: 'space', when: inJoinedSpace, run: () => nav.openStorageSettings('space-view') },
  ], [isFavorite, isPendingSpace])
}
