import { useCallback } from 'react'
import { useTranslation } from 'react-i18next'
import { request } from '../ipc.js'
import { useToast } from '../components/toast/ToastProvider.js'
import { useErrorText } from './useErrorText.js'

interface LocatableShare {
  id: string
  name: string
}

// Re-pointing an owned folder at a new path on disk, from the five surfaces that offer it: the
// folder card's menu, the folder screen's primary button, its work strip, its command-palette entry,
// and Edit Folder's path field.
//
// The two halves fail differently on purpose. `relocate` THROWS — Edit Folder renders the failure in
// its own field error, so it must reach the caller unswallowed and untoasted. `locate` catches,
// because the surfaces that call it have nowhere to put an error but a toast, and a picker that
// returns nothing is a cancel rather than a failure.
export function useLocateShare(spaceId: string) {
  const { t } = useTranslation()
  const toast = useToast()
  const errorText = useErrorText()

  const relocate = useCallback(async (share: LocatableShare, mountPath: string) => {
    await request('owned-folder:relocate', { spaceId, shareId: share.id, mountPath })
    toast.success(t('share.locateSuccess', { name: share.name }))
  }, [spaceId, toast, t])

  const locate = useCallback(async (share: LocatableShare) => {
    const picked = await window.bridge.browseShareFolder()
    if (!picked) return
    try {
      await relocate(share, picked)
    } catch (err) {
      toast.error(errorText(err))
    }
  }, [relocate, toast, errorText])

  return { locate, relocate }
}
