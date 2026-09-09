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
