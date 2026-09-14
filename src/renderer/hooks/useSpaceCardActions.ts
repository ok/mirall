import { useCallback } from 'react'
import { request } from '../ipc.js'
import { setForeignMountEnabled, unmountForeignMount } from './useForeignMount.js'
import { useRunAction } from './useRunAction.js'
import type { FileEntry } from '../types.js'
import type { ShareWithRole } from './useShares.js'
import type { SpaceDialog } from '../components/modals/SpaceDialogs.js'

type SpaceCardActionsInput = {
  spaceId: string
  openDialog: (dialog: SpaceDialog) => void
  revealFile: (path: string) => Promise<unknown>
  cancelPublish: (path: string) => Promise<unknown>
  onOpenShare?: (share: ShareWithRole) => void
}

/**
 * What a folder card or a file card on the space screen can do.
 *
 * Every handler is useCallback'd because the cards are memoized and the decoration heartbeat
 * re-renders the screen once a second for as long as a transfer is live: an identity that changes
 * every render defeats the memo and re-renders every row on every tick.
 *
 * The ones that only open a dialog carry no error path — the dialog reports its own. The ones that
 * write go through useRunAction, so a rejection the card drops still reaches the user as a toast.
 */
export function useSpaceCardActions({ spaceId, openDialog, revealFile, cancelPublish, onOpenShare }: SpaceCardActionsInput) {
  const runAction = useRunAction()
  return {
    openShare: useCallback((share: ShareWithRole) => { onOpenShare?.(share) }, [onOpenShare]),

    openInFinder: useCallback((share: ShareWithRole) => {
      runAction(() => request('share:reveal-folder', { spaceId, ownerKey: share.owner, shareId: share.id }))
    }, [spaceId, runAction]),

    deleteShare: useCallback((share: ShareWithRole) => { openDialog({ kind: 'delete-share', share }) }, [openDialog]),
    mirrorShare: useCallback((share: ShareWithRole) => { openDialog({ kind: 'mirror-share', share }) }, [openDialog]),

    unmount: useCallback((share: ShareWithRole) => {
      runAction(() => unmountForeignMount(share.spaceId, share.id))
    }, [runAction]),

    pauseMirror: useCallback((share: ShareWithRole) => {
      runAction(() => setForeignMountEnabled(share.spaceId, share.id, false))
    }, [runAction]),

    resumeMirror: useCallback((share: ShareWithRole) => {
      runAction(() => setForeignMountEnabled(share.spaceId, share.id, true))
    }, [runAction]),

    revealFile: useCallback((file: FileEntry) => {
      runAction(() => revealFile(file.path))
    }, [revealFile, runAction]),

    removeFile: useCallback((file: FileEntry) => { openDialog({ kind: 'remove-file', file }) }, [openDialog]),

    cancelPublish: useCallback((file: FileEntry) => {
      runAction(() => cancelPublish(file.path))
    }, [cancelPublish, runAction]),
  }
}
