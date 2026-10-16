import { useCallback } from 'react'
import { request } from '../ipc/ipc.js'
import { useRunAction } from './useRunAction.js'

// Transfer controls. No local status is kept: the worker re-derives the row and emits a reconcile
// hint, so the view converges without a client-side optimistic latch. Stable identities, because
// they go straight into memoized rows as props (README.md). A batch cancel sends one request per
// transfer and lets every one settle: one row that cannot be cleared must not stop the rest.
export function useTransferControls() {
  const run = useRunAction()
  const cancelDownload = useCallback(
    (transferId: string) => run(() => request('files:cancel-download', { transferId }), 'transferFailed'),
    [run],
  )
  const pauseDownload = useCallback(
    (transferId: string) => run(() => request('files:pause-download', { transferId })),
    [run],
  )
  const cancelMany = useCallback(
    (transferIds: readonly string[]) => run(async () => {
      const results = await Promise.allSettled(transferIds.map((transferId) => request('files:cancel-download', { transferId })))
      const failed = results.find((r) => r.status === 'rejected')
      if (failed && failed.status === 'rejected') throw failed.reason
    }, 'transferFailed'),
    [run],
  )
  return { cancelDownload, pauseDownload, cancelMany }
}
