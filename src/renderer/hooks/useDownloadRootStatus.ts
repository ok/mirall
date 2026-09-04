// Which download folders are currently unreachable — deleted, ejected, on a disconnected
// network share, or replaced by a file. Drives the app-level banner and the Storage Settings
// warning, so the user learns the folder is gone instead of reading "Transfer failed" on every
// download that tries to land there.
import { useCallback, useEffect, useState } from 'react'
import { subscribe } from '../ipc.js'
import { useQuery } from '../store/useQuery.js'
import { refetchQuery } from '../store/query-store.js'

interface RootsStatus {
  unavailable?: string[]
}

interface TransferErrorMessage {
  errorCode?: string
}

const NO_ROOTS: string[] = []

const list = (res: RootsStatus | undefined) => (Array.isArray(res?.unavailable) ? res.unavailable : NO_ROOTS)

// Scope-less: `event:download-roots-status` carries the whole answer, so the event PUSHES the value
// into the entry rather than poking a re-read. The store's own no-clear-on-error policy is what the
// hand-rolled version's empty catch was reaching for — a failed read keeps the last value on the
// entry, so a worker that is not up yet cannot clear a banner that is currently correct.
//
// The pushing subscription itself is installDownloadRootsBridge's, not this hook's: two components
// mount this, and a per-hook writer wrote the same entry twice per event with two distinct wrapper
// objects — the second defeating the store's identity check and re-rendering everyone again.
export function useDownloadRootStatus() {
  const { data } = useQuery<RootsStatus>('downloads:roots-status', {}, null)
  // Counts transfers that failed on an unreachable folder. The unavailable SET is unchanged by a
  // second failure against the same folder, so it alone cannot tell a consumer that the user just
  // hit the problem again — which is the one moment re-explaining a dismissed (or stack-evicted)
  // toast is warranted.
  const [faultSeq, setFaultSeq] = useState(0)

  const refresh = useCallback(async () => {
    await refetchQuery<RootsStatus>('downloads:roots-status', {}, null).catch(() => undefined)
  }, [])

  // Counting only — the re-probe this failure triggers is the bridge's. A counter is per-consumer
  // state by design (the toast bridge re-explains itself, Storage settings does not), so this one
  // subscription per mount writes nothing shared.
  useEffect(() => subscribe<TransferErrorMessage>('event:transfer-error', (msg) => {
    if (msg?.errorCode !== 'TRANSFER_DEST_UNAVAILABLE') return
    setFaultSeq((n) => n + 1)
  }), [])

  return { unavailable: list(data), faultSeq, refresh }
}
