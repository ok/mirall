// Owns drag-and-drop state for a drop region: classifies dragged payloads (files vs folder) via depth-tracked enter/leave and routes drops to the callbacks.
import { useCallback, useEffect, useRef, useState } from 'react'
import { inspectDragItems, isFolderDrop, firstDirectoryName } from '../dragShare.js'
import { mountPathFromDrop } from '../sharePaths.js'

export type DragKind = 'idle' | 'files' | 'folder'

interface UseDragShareOptions {
  onFiles: (files: File[]) => void
  onFolder?: (path: string) => void
  folderEnabled?: boolean
  onFolderUnsupported?: () => void
}

interface DragShareState {
  dragKind: DragKind
  fileCount: number
  folderName: string | null
}

interface DragShareResult extends DragShareState {
  dragActive: boolean
  dragHandlers: {
    onDragEnter: (e: React.DragEvent) => void
    onDragOver: (e: React.DragEvent) => void
    onDragLeave: (e: React.DragEvent) => void
    onDrop: (e: React.DragEvent) => void
  }
}

export function useDragShare({
  onFiles,
  onFolder,
  folderEnabled,
  onFolderUnsupported,
}: UseDragShareOptions): DragShareResult {
  const [state, setState] = useState<DragShareState>({ dragKind: 'idle', fileCount: 0, folderName: null })
  // dragenter/dragleave fire for every descendant the pointer crosses; counting
  // depth resets only when it truly leaves the region.
  const depth = useRef(0)

  const reset = useCallback(() => {
    depth.current = 0
    setState({ dragKind: 'idle', fileCount: 0, folderName: null })
  }, [])

  const onDragEnter = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    depth.current += 1
  }, [])

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    e.preventDefault()
    e.dataTransfer.dropEffect = 'copy'
    const next = inspectDragItems(e.dataTransfer.items)
    setState((prev) =>
      prev.dragKind === next.kind && prev.fileCount === next.count && prev.folderName === next.folderName
        ? prev
        : { dragKind: next.kind, fileCount: next.count, folderName: next.folderName },
    )
  }, [])

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.dataTransfer.types.includes('Files')) return
    // relatedTarget is null when the pointer leaves the window entirely.
    if (e.relatedTarget === null) {
      reset()
      return
    }
    depth.current -= 1
    if (depth.current <= 0) reset()
  }, [reset])

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      if (!e.dataTransfer.types.includes('Files')) return
      e.preventDefault()
      reset()
      if (isFolderDrop(e.dataTransfer.items)) {
        if (!folderEnabled || !onFolder) {
          onFolderUnsupported?.()
          return
        }
        if (!firstDirectoryName(e.dataTransfer.items)) return
        const file = e.dataTransfer.files[0]
        const path = file ? mountPathFromDrop(window.bridge.getPathForFile(file)) : ''
        if (path) onFolder(path)
        return
      }
      const files = Array.from(e.dataTransfer.files)
      if (files.length > 0) onFiles(files)
    },
    [folderEnabled, onFolder, onFiles, onFolderUnsupported, reset],
  )

  // A drag that ends outside the grid (dropped elsewhere, or the OS drag is
  // cancelled) never delivers the balancing dragleave; recover here so the
  // full-bleed overlay can't get stuck covering the content.
  useEffect(() => {
    window.addEventListener('drop', reset)
    window.addEventListener('dragend', reset)
    return () => {
      window.removeEventListener('drop', reset)
      window.removeEventListener('dragend', reset)
    }
  }, [reset])

  return {
    ...state,
    dragActive: state.dragKind !== 'idle',
    dragHandlers: { onDragEnter, onDragOver, onDragLeave, onDrop },
  }
}
