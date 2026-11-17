// Whether detailed logging is on, for the session. Module-level rather than state of the
// Diagnostics screen because the problem to reproduce is almost always on another screen: logging
// stays on until it is switched off or a diagnostics file is saved, and the screen shows it on when
// the user comes back. Read through useSyncExternalStore, so there is no second copy to disagree.
//
// The value is what the worker IS doing, not what was asked for: verbose is shared — one client
// releasing it does not switch it off while another still wants it — so the worker's reply is the
// answer and the optimistic value is only the starting point. The worker is written before main
// because its reply is that answer: a rejection puts the value back with nothing written anywhere,
// and main is then given the same answer. Only the latest change's reply is applied.
import { onResync, request } from '../ipc/ipc.js'

let on = false
let seq = 0

const listeners = new Set<() => void>()

function show(next: boolean): void {
  if (on === next) return
  on = next
  listeners.forEach((fn) => { fn() })
}

export function subscribeDetailedLogging(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

export function isDetailedLoggingOn(): boolean {
  return on
}

/** Resolves with the effective state, or null when a later change superseded this one. */
export async function setDetailedLogging(next: boolean): Promise<boolean | null> {
  const mine = ++seq
  const previous = on
  show(next)
  let reply
  try {
    reply = await request('setVerbose', { verbose: next })
  } catch (err) {
    if (mine !== seq) return null
    show(previous)
    throw err
  }
  if (mine !== seq) return null
  const effective = typeof reply?.verbose === 'boolean' ? reply.verbose : next
  show(effective)
  await window.bridge.setVerbose(effective)
  return mine === seq ? effective : null
}

// A new worker starts with the refcount empty, so logging that is on is asked for again or the
// lines it is on for are the ones that were never recorded.
onResync(() => {
  if (on) request('setVerbose', { verbose: true }).catch(() => {})
})
