// Verbose is a property of the worker's stdout, which main broadcasts to every window, so a
// per-client verbose is not achievable and this does not pretend otherwise. What is achievable, and
// what this implements: on while ANY client wants it, released when a client says so or goes away.
// Last-writer-wins was the alternative, and under it one client leaving the diagnostics screen
// silenced another's still-open one, while a client that crashed left it stuck on.
//
// The boot value is deliberately NOT a floor. It arrives on the bootstrap frame from main's live
// debug gate, which the dev console itself mutates — so treating it as one would let
// `verbose(true)` plus any worker restart make verbose unreleasable for the rest of the session.
// Nothing here fights the boot value either: `apply` runs only when a client asks, so a worker
// booted verbose stays verbose until one does.
export function createVerbosePolicy({ apply }) {
  const wanting = new Set()
  const effective = () => wanting.size > 0
  return {
    set(clientId, on) {
      if (on) wanting.add(clientId)
      else wanting.delete(clientId)
      apply(effective())
      return effective()
    },
    release(clientId) {
      if (wanting.delete(clientId)) apply(effective())
    },
    effective,
  }
}
