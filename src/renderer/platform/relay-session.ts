// Whether the stored relay identity differs from the one the running worker booted with.
// Session-scoped on purpose: the only way it becomes false again is the worker restarting, and
// anything that ends this session does exactly that. Module-level rather than component state
// because the notice has to survive navigating away from Settings and back.
let pending = false

export function isReconnectPending(): boolean {
  return pending
}

export function setReconnectPending(next: boolean): void {
  pending = next
}

// Whether a relay change has been committed that the worker could not apply itself — a transfer was
// moving, or the reconnect was throttled. Armed from that reply and disarmed by the reconnect, not
// derived from status alone: on a LAN the hole punch moves a reconnected connection straight back to
// direct, so a purely derived notice would reappear for ever under `always`. It is gated on live
// status in turn, so it also goes away when the peers cycle by themselves.
let applyArmed = false

export function isApplyArmed(): boolean {
  return applyArmed
}

export function setApplyArmed(next: boolean): void {
  applyArmed = next
}
