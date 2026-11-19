// The two transfer limits: read from the worker's settings and written back with one request.
import { useCallback, useMemo, useRef, useState } from 'react'
import { request } from '../ipc/ipc.js'
import { useSettings } from './useSettings.js'
import type { BandwidthLimits } from '../platform/global.js'

export function useBandwidthLimits() {
  // 0 is a meaningful limit (unlimited), so nothing stands in for it before the read lands: `limits`
  // is undefined until then.
  const { data: settings, error: readError } = useSettings()
  const downloadKBps = settings?.network.downloadKBps
  const uploadKBps = settings?.network.uploadKBps
  const limits: BandwidthLimits | undefined = useMemo(
    () => (downloadKBps === undefined || uploadKBps === undefined ? undefined : { downloadKBps, uploadKBps }),
    [downloadKBps, uploadKBps],
  )
  const [saveFailed, setSaveFailed] = useState(false)
  const [applying, setApplying] = useState(false)
  const applySeq = useRef(0)

  // The worker persists the limit and applies it in one request, and its reply pokes the settings
  // query, so `limits` is what is stored: a refused write leaves the previous limit in place. Only
  // the latest apply reports its outcome.
  const apply = useCallback((next: BandwidthLimits) => {
    const seq = ++applySeq.current
    const latest = () => seq === applySeq.current
    setSaveFailed(false)
    setApplying(true)
    request('settings:set-bandwidth', { ...next }).then(
      () => { if (latest()) setApplying(false) },
      () => {
        if (!latest()) return
        setSaveFailed(true)
        setApplying(false)
      },
    )
  }, [])

  return { limits, readError, applying, saveFailed, apply }
}
