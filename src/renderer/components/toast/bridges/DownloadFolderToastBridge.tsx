// Renderless bridge turning an unreachable space folder into toasts: a sticky error while a space's
// folder cannot be reached, a brief notice when it comes back, and the error simply gone when no
// space downloads to it any more. A recent folder that is not any space's folder never toasts; the
// Download-to menu shows it disabled instead. What to do on each change is folderToastDecision's.
//
// Deliberately the same shape as ConnectivityToastBridge — both report a persistent, app-wide
// fault that blocks one subsystem, offer one way to fix it, and clear themselves when the
// underlying condition does. A single sticky toast (one `id`, so re-probing replaces rather
// than stacks) is what keeps one missing folder from reading as N failed downloads.
import { useEffect, useRef, useState } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../ToastProvider.js'
import { subscribe } from '../../../ipc/ipc.js'
import { useDownloadRootStatus } from '../../../hooks/useDownloadRootStatus.js'
import { useSettings } from '../../../hooks/useSettings.js'
import { folderToastDecision, type FolderToastState } from '../../../model/download-folder-toast.js'
import { lastSegment } from '../../../../shared/contract/paths.js'
import type { Space } from '../../../types/types.js'

const TOAST_ID = 'download-folder'

interface DownloadFolderToastBridgeProps {
  spaces: Space[]
  onOpenSpace: (spaceId: string) => void
}

export default function DownloadFolderToastBridge({ spaces, onOpenSpace }: DownloadFolderToastBridgeProps) {
  const { unavailable } = useDownloadRootStatus()
  const host = useSettings().data?.hostPaths
  const { t } = useTranslation()
  const toast = useToast()
  // Counts transfers that failed on an unreachable folder. A second failure against the same folder
  // leaves the unavailable set as it was, and it is the moment to name the folder again to a user
  // who dismissed the toast.
  const [faultSeq, setFaultSeq] = useState(0)
  const stateRef = useRef<FolderToastState | null>(null)
  const onOpenSpaceRef = useRef(onOpenSpace)

  useEffect(() => {
    onOpenSpaceRef.current = onOpenSpace
  }, [onOpenSpace])

  useEffect(() => subscribe<{ errorCode?: string }>('event:transfer-error', (msg) => {
    if (msg?.errorCode === 'TRANSFER_DEST_UNAVAILABLE') setFaultSeq((n) => n + 1)
  }), [])

  useEffect(() => {
    // Folders are compared by the worker's path rules: nothing is said before they are known.
    if (!host) return
    const { state, action } = folderToastDecision({ previous: stateRef.current, spaces, unavailable, faultSeq, host })
    stateRef.current = state
    if (!action) return
    if (action.kind === 'dismiss') {
      toast.dismiss(TOAST_ID)
      return
    }
    if (action.kind === 'restored') {
      toast.success(t('downloadFolder.restoredToast'), { id: TOAST_ID, duration: 4000 })
      return
    }
    toast.error(t('downloadFolder.unavailableSpace', {
      space: action.more > 0 ? `${action.space} (+${action.more})` : action.space,
      folder: lastSegment(action.folder, host.sep),
    }), {
      id: TOAST_ID,
      duration: 0,
      action: {
        label: t('downloadFolder.chooseAnother'),
        onClick: () => onOpenSpaceRef.current(action.spaceId),
      },
    })
  }, [spaces, unavailable, faultSeq, host, t, toast])

  return null
}
