import { useCallback, useEffect, useRef } from 'react'
import type { PendingSpaceAction } from '../shell/space-actions.js'
import type { ShareWithRole } from './useShares.js'
import type { SpaceDialog } from '../components/modals/SpaceDialogs.js'

type PendingSpaceActionInput = {
  spaceId: string
  /** An action raised before this screen existed — from the folder screen, or the title bar. */
  pendingAction: PendingSpaceAction | null
  onActionConsumed: () => void
  shares: ShareWithRole[]
  sharesLoading: boolean
  isPending: boolean
  isLegacy: boolean
  openDialog: (dialog: SpaceDialog) => void
  /** Opens the OS file picker — the screen owns the hidden <input>, so it does the click. */
  onAddFiles: () => void
}

/**
 * Consuming an action that arrived from outside the space screen, and the folder picker one of
 * them opens.
 *
 * The picker is modal to the user, not to the app: it stays open for as long as they take, and
 * they can leave the space or close the screen while it is. The guard is therefore scoped to the
 * mount and the space — an effect's own cleanup flag is not, because the effect that opens the
 * picker re-runs the moment the action it came from is consumed, which would cancel a picker the
 * user has not answered yet.
 */
export function usePendingSpaceAction(input: PendingSpaceActionInput) {
  const { spaceId, pendingAction, onActionConsumed, shares, sharesLoading, isPending, isLegacy, openDialog, onAddFiles } = input

  const mounted = useRef(true)
  const openSpace = useRef(spaceId)
  useEffect(() => {
    openSpace.current = spaceId
    return () => { mounted.current = false }
  }, [spaceId])

  const openFolderPicker = useCallback(() => {
    const openedFor = spaceId
    void window.bridge.browseShareFolder().then((picked) => {
      if (!picked || mounted.current !== true || openSpace.current !== openedFor) return
      openDialog({ kind: 'add-folder', path: picked })
    })
  }, [spaceId, openDialog])

  useEffect(() => {
    if (!pendingAction) return
    if (pendingAction.kind === 'mirror') {
      const share = shares.find((s) => s.id === pendingAction.shareId)
      // The listing is the authority on the folder. While it is still loading a miss means "not
      // here yet", so the action waits; once it has loaded, a miss means the folder is gone and
      // the action is dropped rather than held forever.
      if (!share) {
        if (!sharesLoading) onActionConsumed()
        return
      }
      openDialog({ kind: 'mirror-share', share })
      onActionConsumed()
      return
    }
    const { action } = pendingAction
    // Leave is the only action a legacy space keeps: everything else writes, and the data layer
    // refuses it (SPACE_UNSUPPORTED) because there is no content key and no way to mint one.
    if (action === 'leave') openDialog({ kind: 'leave' })
    else if (isPending || isLegacy) { /* refused below the UI; drop it rather than hold it */ }
    else if (action === 'add-files') onAddFiles()
    else if (action === 'add-folder') openFolderPicker()
    else if (action === 'invite') openDialog({ kind: 'invite' })
    else if (action === 'edit') openDialog({ kind: 'edit' })
    onActionConsumed()
  }, [pendingAction, shares, sharesLoading, isPending, isLegacy, onActionConsumed, openFolderPicker, openDialog, onAddFiles])

  return { openFolderPicker }
}
