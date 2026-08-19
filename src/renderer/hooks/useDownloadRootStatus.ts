// Which download folders are currently unreachable — deleted, ejected, on a disconnected
// network share, or replaced by a file. Drives the app-level banner and the Storage Settings
// warning, so the user learns the folder is gone instead of reading "Transfer failed" on every
// download that tries to land there.
import { useCallback, useEffect, useState } from 'react'
import { request, subscribe } from '../ipc.js'

interface RootsStatus {
  unavailable?: string[]
}

interface TransferErrorMessage {
  errorCode?: string
}

export function useDownloadRootStatus() {
  const [unavailable, setUnavailable] = useState<string[]>([])
  // Counts transfers that failed on an unreachable folder. The unavailable SET is unchanged by a
  // second failure against the same folder, so it alone cannot tell a consumer that the user just
  // hit the problem again — which is the one moment re-explaining a dismissed (or stack-evicted)
  // toast is warranted.
  const [faultSeq, setFaultSeq] = useState(0)

  const refresh = useCallback(async () => {
    try {
      const res = await request('downloads:roots-status') as RootsStatus
      setUnavailable(Array.isArray(res?.unavailable) ? res.unavailable : [])
    } catch {
      // A worker that isn't up yet is not evidence the folder is gone — leave the last
      // known state alone rather than clearing a banner that is currently correct.
    }
  }, [])

  useEffect(() => {
    void refresh()
    const unsubs = [
      subscribe<RootsStatus>('event:download-roots-status', (msg) => {
        setUnavailable(Array.isArray(msg?.unavailable) ? msg.unavailable : [])
      }),
      // The worker probes on a 60s tick, so a download that just failed on a gone folder would
      // otherwise sit behind a generic-looking error for up to a minute before the banner
      // explains it. The failure itself is the signal to re-probe now.
      subscribe<TransferErrorMessage>('event:transfer-error', (msg) => {
        if (msg?.errorCode !== 'TRANSFER_DEST_UNAVAILABLE') return
        setFaultSeq((n) => n + 1)
        void refresh()
      }),
    ]
    return () => { for (const off of unsubs) off() }
  }, [refresh])

  return { unavailable, faultSeq, refresh }
}
