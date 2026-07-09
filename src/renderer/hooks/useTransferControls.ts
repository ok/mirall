import { request } from '../ipc.js'

// Fire-and-forget transfer controls. No local status is kept: the worker re-derives the row and
// emits a reconcile hint, so the view converges without a client-side optimistic latch.
export function useTransferControls() {
  return {
    cancelDownload: (transferId: string) => { void request('files:cancel-download', { transferId }) },
    pauseDownload: (transferId: string) => { void request('files:pause-download', { transferId }) },
  }
}
