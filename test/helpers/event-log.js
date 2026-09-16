// The event frames a peer emitted before its caller could listen, plus the subscribe-at-call-time
// listeners. The harness feeds every parsed `event:*` frame through `deliver`; until `seal()` the
// frame is also kept, so a wait attached after launchPeer resolves can still find an edge the
// worker consumed inside its own boot. After `seal()` nothing is recorded and a wait is a plain
// listener.
export function createEventLog({ maxBacklog = 512 } = {}) {
  const listeners = new Map()
  const backlog = []
  const counts = new Map()
  let sealed = false
  let dropped = 0

  return {
    deliver(msg) {
      counts.set(msg.type, (counts.get(msg.type) || 0) + 1)
      if (!sealed) {
        if (backlog.length >= maxBacklog) { backlog.shift(); dropped++ }
        backlog.push(msg)
      }
      for (const cb of listeners.get(msg.type) ?? []) cb(msg)
      for (const cb of listeners.get('*') ?? []) cb(msg)
    },
    seal() { sealed = true },
    on(type, cb) {
      if (!listeners.has(type)) listeners.set(type, [])
      listeners.get(type).push(cb)
      return () => {
        const arr = listeners.get(type)
        const i = arr ? arr.indexOf(cb) : -1
        if (i !== -1) arr.splice(i, 1)
      }
    },
    // Handed out once: a second wait for the same type must not see what the first one took.
    takeFromBacklog(type, pred) {
      const i = backlog.findIndex((m) => m.type === type && pred(m))
      if (i === -1) return null
      return backlog.splice(i, 1)[0]
    },
    summary() {
      const seen = [...counts].map(([type, n]) => `${type}×${n}`).join(' ')
      const pending = backlog.map((m) => m.type).join(' ')
      return `events since spawn: ${seen || '(none)'}; unconsumed boot backlog: ${pending || '(empty)'}` +
        (dropped ? `; ${dropped} boot event(s) dropped past the ${maxBacklog} cap` : '')
    },
  }
}
