// The two relay changes that are waiting on the running worker, and the one thing that ends them.
// Module-level rather than component state because both notices have to survive navigating away
// from Settings and back; read through useSyncExternalStore, never mirrored into a useState, so a
// second copy cannot disagree with this one.
//
// A new worker PROCESS is what clears both, and it clears them here rather than at the act that
// asked for it: the next worker is spawned from the STORED relay identity and reads the stored
// relay at boot, so by the time it greets us the change has landed — whoever caused the restart.
// An act that resolves without replacing the worker therefore leaves the notice up, which is the
// only affordance for retrying it. A re-read for any other reason is the same process, still
// running on what it booted with, and says nothing about either flag.
import { onResync } from '../ipc/ipc.js'

// Whether the stored relay identity differs from the one the running worker booted with.
let pending = false

// Whether a relay change has been committed that the worker could not apply itself — a transfer was
// moving, or the reconnect was throttled. Armed from that reply rather than derived from status
// alone: on a LAN the hole punch moves a reconnected connection straight back to direct, so a purely
// derived notice would reappear for ever under `always`. It is gated on live status in turn, so it
// also goes away when the peers cycle by themselves.
let applyArmed = false

const listeners = new Set<() => void>()

function announce(): void {
  listeners.forEach((fn) => { fn() })
}

export function subscribeRelaySession(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function isReconnectPending(): boolean {
  return pending
}

export function setReconnectPending(next: boolean): void {
  if (pending === next) return
  pending = next
  announce()
}

export function isApplyArmed(): boolean {
  return applyArmed
}

export function setApplyArmed(next: boolean): void {
  if (applyArmed === next) return
  applyArmed = next
  announce()
}

onResync((reason) => {
  if (reason !== 'new-worker') return
  setReconnectPending(false)
  setApplyArmed(false)
})
