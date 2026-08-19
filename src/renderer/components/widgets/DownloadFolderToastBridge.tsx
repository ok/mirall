// Renderless bridge turning download-folder availability into toasts: a sticky error while a
// folder is unreachable, and a brief notice when it comes back.
//
// Deliberately the same shape as ConnectivityToastBridge — both report a persistent, app-wide
// fault that blocks one subsystem, offers one way to fix it, and clears itself when the
// underlying condition does. A single sticky toast (one `id`, so re-probing replaces rather
// than stacks) is what keeps one missing folder from reading as N failed downloads.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../toast/ToastProvider.js'
import { useDownloadRootStatus } from '../../hooks/useDownloadRootStatus.js'

const TOAST_ID = 'download-folder'

interface Props {
  onChangeFolder: () => void
}

export default function DownloadFolderToastBridge({ onChangeFolder }: Props) {
  const { unavailable, faultSeq } = useDownloadRootStatus()
  const { t } = useTranslation()
  const toast = useToast()
  // Only transitions produce a toast, so a re-probe that finds the same folder still missing
  // doesn't re-raise one the user has dismissed. A fresh FAILED DOWNLOAD counts as a transition
  // though (faultSeq): the toast stack keeps at most 4 and evicts the oldest, which a sticky
  // toast always is, so without that the only surface explaining the fault can disappear on its
  // own and never come back.
  const previousRef = useRef<string | null>(null)
  const onChangeFolderRef = useRef(onChangeFolder)

  useEffect(() => {
    onChangeFolderRef.current = onChangeFolder
  }, [onChangeFolder])

  useEffect(() => {
    // Several roots can be unreachable at once (a per-space override alongside the global one),
    // almost always from one cause — an ejected disk. Name the first and count the rest rather
    // than stacking a toast per root.
    const [first, ...rest] = unavailable
    const key = JSON.stringify([unavailable, faultSeq])
    const previous = previousRef.current
    previousRef.current = key
    if (previous === key) return

    if (first) {
      toast.error(t('downloadFolder.unavailableToast', {
        path: rest.length > 0 ? `${first} (+${rest.length})` : first,
      }), {
        id: TOAST_ID,
        duration: 0,
        action: {
          label: t('downloadFolder.changeFolder'),
          onClick: () => onChangeFolderRef.current(),
        },
      })
      return
    }

    // Recovered. `previous === null` is the first probe of a healthy session, which is not a
    // recovery and must stay silent.
    if (previous) toast.success(t('downloadFolder.restoredToast'), { id: TOAST_ID, duration: 4000 })
  }, [unavailable, faultSeq, t, toast])

  return null
}
