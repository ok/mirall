// 'interrupted' = the sender is online but the transfer stopped (content evicted, re-indexing,
// holder churn); anything else (incl. a legacy frame with no reason) reads as the sender offline.
// Plain JS so it unit-tests in the Node runner without pulling in the dispatcher's i18n/ipc deps.
export function pausedBodyKey(reason) {
  return reason === 'interrupted'
    ? 'notifications.transferPausedInterruptedBody'
    : 'notifications.transferPausedBody'
}
