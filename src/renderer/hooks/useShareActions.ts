import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc/ipc.js'
import { useToast } from '../components/toast/ToastProvider.js'
import { useRunAction } from './useRunAction.js'
import { useErrorText } from './useErrorText.js'
import type { ShareWithRole } from './useShares.js'

type ShareActionDeps = {
  spaceId: string
  share: ShareWithRole
  isYou: boolean
  onBack: () => void
  locate: (share: ShareWithRole) => Promise<unknown>
  relocate: (share: ShareWithRole, mountPath: string) => Promise<unknown>
  setForeignMountEnabled: (spaceId: string, shareId: string, enabled: boolean) => Promise<unknown>
  unmountForeignMount: (spaceId: string, shareId: string) => Promise<unknown>
}

/**
 * The acts a folder screen offers on its own share.
 *
 * Split by who reports the failure, and by who waits. Reveal, pause and unmount are handed to
 * controls as `() => void`, so they go through useRunAction and their failure becomes a toast.
 * Delete toasts too but stays awaitable, because its confirm dialog holds a busy state for the
 * duration. Rename and relocate REJECT on purpose: the edit modal reports those itself, and a
 * toast as well would tell the user twice.
 */
export function useShareActions({
  spaceId, share, isYou, onBack, locate, relocate, setForeignMountEnabled, unmountForeignMount,
}: ShareActionDeps) {
  const { t } = useTranslation()
  const toast = useToast()
  const run = useRunAction()
  const errorText = useErrorText()
  const shareId = share.id

  const revealFolder = useCallback(
    () => run(() => request('share:reveal-folder', { spaceId, ownerKey: share.owner, shareId })),
    [run, spaceId, share.owner, shareId],
  )

  // Awaitable, unlike the rest: the confirm dialog holds its busy state for the duration, so the
  // promise has to reach it. The toast is still ours — the dialog reports nothing itself.
  const deleteShare = useCallback(async () => {
    try {
      await request('owned-folder:delete', { spaceId, shareId })
      onBack()
    } catch (err) {
      toast.error(errorText(err))
    }
  }, [spaceId, shareId, onBack, toast, errorText])

  // One act behind both surfaces (the strip and the menu), so no state can exist in one and not the
  // other. Which durable flag it writes is the only thing the role changes.
  const setPaused = useCallback((paused: boolean) => run(() => (isYou
    ? request(paused ? 'owned-folder:pause-index' : 'owned-folder:resume-index', { spaceId, shareId })
    : setForeignMountEnabled(spaceId, shareId, !paused))),
  [run, isYou, spaceId, shareId, setForeignMountEnabled])

  const unmount = useCallback(
    () => run(() => unmountForeignMount(spaceId, shareId)),
    [run, spaceId, shareId, unmountForeignMount],
  )

  const rename = useCallback(async (name: string) => {
    await request('share:rename', { spaceId, shareId, name })
    toast.success(t('share.renameSuccess', { name }))
  }, [spaceId, shareId, toast, t])

  const relocateTo = useCallback(async (mountPath: string): Promise<void> => {
    if (isYou) { await relocate(share, mountPath); return }
    await request('foreign-folder:relocate', { spaceId, shareId, mountPath })
    toast.success(t('share.mirrorLocationSuccess'))
  }, [isYou, relocate, share, spaceId, shareId, toast, t])

  const onStripAction = useCallback((action: 'locate' | 'resume' | 'pause') => {
    if (action === 'locate') void locate(share)
    else setPaused(action === 'pause')
  }, [locate, share, setPaused])

  return { revealFolder, deleteShare, setPaused, unmount, rename, relocateTo, onStripAction }
}
