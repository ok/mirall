// How the data layer tells the backup service that something worth backing up changed, without
// importing it: the service installs the receiver when it starts and removes it when it stops, and a
// hint with no receiver installed is dropped.
let receiver = null

export function initBackupHints(fn) {
  receiver = fn
}

export function resetBackupHints() {
  receiver = null
}

export function backupHint(urgency) {
  receiver?.(urgency)
}
