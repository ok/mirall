// 'interrupted' = the sender is online but the transfer stopped (content evicted, re-indexing,
// holder churn); anything else (incl. a legacy frame with no reason) reads as the sender offline.
// Plain JS so it unit-tests in the Node runner without pulling in the dispatcher's i18n/ipc deps.
/** @param {string | undefined} reason */
export function pausedBodyKey(reason) {
  return reason === 'interrupted'
    ? 'notifications.transferPausedInterruptedBody'
    : 'notifications.transferPausedBody'
}

/** @param {string | undefined} reason */
export function pausedManyBodyKey(reason) {
  return reason === 'interrupted'
    ? 'notifications.transferPausedInterruptedManyBody'
    : 'notifications.transferPausedManyBody'
}
