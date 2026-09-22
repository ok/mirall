import { useCallback } from 'react'
import { request } from '../ipc/ipc.js'
import { useRunAction } from './useRunAction.js'

// Transfer controls. No local status is kept: the worker re-derives the row and emits a reconcile
// hint, so the view converges without a client-side optimistic latch. The rows take these as
// `(transferId) => void`, so a refusal is reported here. Stable identities, because they go straight
// into memoized rows as props (README.md).
export function useTransferControls() {
  const run = useRunAction()
  const cancelDownload = useCallback(
    (transferId: string) => run(() => request('files:cancel-download', { transferId })),
    [run],
  )
  const pauseDownload = useCallback(
    (transferId: string) => run(() => request('files:pause-download', { transferId })),
    [run],
  )
  return { cancelDownload, pauseDownload }
}
