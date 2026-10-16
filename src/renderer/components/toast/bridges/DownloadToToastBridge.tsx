// Renderless bridge naming a space's new download folder whenever it changes: from a Download-to
// menu, the controls-row button, Edit Space, or another window. A download into the folder the space
// already uses changes nothing and says nothing.
import { useEffect, useRef } from 'react'
import { useTranslation } from 'react-i18next'
import { useToast } from '../ToastProvider.js'
import { useSettings } from '../../../hooks/useSettings.js'
import { downloadToToastId, folderMovedText } from '../../../hooks/useDownloadTo.js'
import { sameFolder } from '../../../model/download-folders.js'
import type { Space } from '../../../types/types.js'

interface DownloadToToastBridgeProps {
  spaces: Space[]
}

export default function DownloadToToastBridge({ spaces }: DownloadToToastBridgeProps) {
  const { t } = useTranslation()
  const toast = useToast()
  const host = useSettings().data?.hostPaths
  // spaceId → folder as last seen. Null until the first list, which is the state, not a change.
  const previousRef = useRef<Map<string, string> | null>(null)

  useEffect(() => {
    // Folders are compared by the worker's path rules: nothing is compared before they are known.
    if (!host) return
    const previous = previousRef.current
    previousRef.current = new Map(spaces.map((s) => [s.spaceId, s.downloadFolder]))
    if (!previous) return
    for (const space of spaces) {
      const before = previous.get(space.spaceId)
      if (before === undefined || sameFolder(before, space.downloadFolder, host)) continue
      toast.info(folderMovedText(t, space.name, space.downloadFolder, host), { id: downloadToToastId(space.spaceId) })
    }
  }, [spaces, host, t, toast])

  return null
}
