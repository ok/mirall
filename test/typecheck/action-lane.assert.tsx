// Compile-time pins for ActionLane's verbs: a row must supply a verb for every action its context
// can produce, so a button the table offers can never render without something to run.
import ActionLane from '../../src/renderer/components/cards/ActionLane.js'

const noop = () => {}
const row = { status: 'remote' as const }
const transfer = { pause: noop, cancel: noop, discard: noop, dismiss: noop }
const fetch = { download: noop, resume: noop, retry: noop, reveal: noop }

export const looseOk = (
  <ActionLane row={row} context={{ isOwn: true, manualControls: true, ownerFileVerbs: true }}
    verbs={{ ...transfer, ...fetch, unshare: noop, 'cancel-publish': noop }} />
)
export const folderOk = (
  <ActionLane row={row} context={{ isOwn: false, manualControls: true, ownerFileVerbs: false }} verbs={{ ...transfer, ...fetch }} />
)

export const looseMissingUnshare = (
  // @ts-expect-error a row that can withdraw a file must say how
  <ActionLane row={row} context={{ isOwn: true, manualControls: true, ownerFileVerbs: true }} verbs={{ ...transfer, ...fetch, 'cancel-publish': noop }} />
)
export const folderMissingDismiss = (
  // @ts-expect-error every transfer action the table can offer needs its verb
  <ActionLane row={row} context={{ isOwn: false, manualControls: true, ownerFileVerbs: false }} verbs={{ pause: noop, cancel: noop, discard: noop, ...fetch }} />
)
