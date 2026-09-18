// In-process `ipc` double for Tier-2 single-store tests. Records emitted events so tests can assert
// on them, and registered handlers so a test whose subject IS a handler can call one.
export function createFakeIpc() {
  const events = []
  const handlers = new Map()
  return {
    ipc: {
      emit: (type, payload) => { events.push({ type, payload }) },
      handle: (name, fn) => { handlers.set(name, fn) },
      respond: () => {},
      start: () => {},
    },
    events,
    call: (name, msg) => {
      const fn = handlers.get(name)
      if (!fn) throw new Error('no handler registered for ' + name)
      return fn(msg)
    },
    emitted: (type) => events.filter((e) => e.type === type),
    lastStatus: (shareId) => {
      const matches = events.filter((e) => e.type === 'event:owned-folder-mount-status' &&
        (shareId === undefined || e.payload?.shareId === shareId))
      return matches.length ? matches[matches.length - 1].payload.status : null
    },
  }
}
