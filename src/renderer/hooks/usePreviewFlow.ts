import { useCallback, useRef, useState } from 'react'
import type { ScanPreview, PreviewProgress } from '../types.js'

export interface PreviewHandle {
  previewId: string
  result: Promise<ScanPreview>
}

export interface PreviewFlow {
  preview: ScanPreview | null
  progress: PreviewProgress | null
  loading: boolean
  run: (start: (onProgress: (p: PreviewProgress) => void) => PreviewHandle) => Promise<void>
  cancel: () => void
  reset: () => void
}

// Shared owned/foreign scan-preview orchestration: run a preview (streaming progress),
// track loading + result, and cancel the in-flight scan. `start` produces the backend
// handle (previewOwnedMount / previewForeignMount); `cancelPreview` aborts it by id.
export function usePreviewFlow(cancelPreview: (previewId: string) => void): PreviewFlow {
  const [preview, setPreview] = useState<ScanPreview | null>(null)
  const [progress, setProgress] = useState<PreviewProgress | null>(null)
  const [loading, setLoading] = useState(false)
  const idRef = useRef<string | null>(null)

  const reset = useCallback(() => {
    setPreview(null)
    setProgress(null)
    setLoading(false)
  }, [])

  const cancel = useCallback(() => {
    if (idRef.current) {
      cancelPreview(idRef.current)
      idRef.current = null
    }
    setLoading(false)
    setProgress(null)
  }, [cancelPreview])

  const run = useCallback(async (start: (onProgress: (p: PreviewProgress) => void) => PreviewHandle) => {
    setPreview(null)
    setProgress(null)
    setLoading(true)
    const handle = start(setProgress)
    idRef.current = handle.previewId
    try {
      setPreview(await handle.result)
    } finally {
      idRef.current = null
      setLoading(false)
    }
  }, [])

  return { preview, progress, loading, run, cancel, reset }
}
