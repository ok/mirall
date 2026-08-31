import { request } from '../ipc.js'

// Fire-and-forget transfer controls. No local status is kept: the worker re-derives the row and
// emits a reconcile hint, so the view converges without a client-side optimistic latch.
//
// Module-level rather than closed over per render: these go straight into memoized rows as props,
// and a fresh arrow per render made every row's shallow compare fail — the hook handed out two new
// identities a second under the decoration heartbeat, which is exactly what the memo exists to
// stop. They close over nothing, so there is nothing to capture.
const cancelDownload = (transferId: string): void => { void request('files:cancel-download', { transferId }) }
const pauseDownload = (transferId: string): void => { void request('files:pause-download', { transferId }) }

const CONTROLS = Object.freeze({ cancelDownload, pauseDownload })

export function useTransferControls() {
  return CONTROLS
}
