import { request } from '../ipc.js'

// Fire-and-forget transfer controls. No local status is kept: the worker re-derives the row and
// emits a reconcile hint, so the view converges without a client-side optimistic latch.
// Module-level because they go straight into memoized rows as props (README.md); they close over nothing.
const cancelDownload = (transferId: string): void => { void request('files:cancel-download', { transferId }) }
const pauseDownload = (transferId: string): void => { void request('files:pause-download', { transferId }) }

const CONTROLS = Object.freeze({ cancelDownload, pauseDownload })

export function useTransferControls() {
  return CONTROLS
}
