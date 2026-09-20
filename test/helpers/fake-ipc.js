// In-process `ipc` double for Tier-2 single-store tests. Records emitted events so tests can assert
// on them, and registered handlers so a test whose subject IS a handler can call one.
//
// One anonymous client stands in for the single renderer these tests model. It is passed on the
// handler context, so a handler that reads ctx.client works here exactly as it does in production.
const FAKE_CLIENT = Object.freeze({ id: 1, trust: 'host' })

export function createFakeIpc() {
  const events = []
  const handlers = new Map()
  const disconnectHooks = []
  const emitListeners = new Set()
  return {
    ipc: {
      // `to` is recorded rather than honoured: with one client there is nowhere else for a targeted
      // event to go, and a test asserting on routing wants to see the target that was named.
      emit: (type, payload, opts) => {
        const frame = { type, payload, to: opts?.to ?? null }
        events.push(frame)
        for (const fn of emitListeners) fn(frame)
      },
      handle: (name, fn) => { handlers.set(name, fn) },
      respond: () => {},
      start: () => {},
      onClientAttach: () => {},
      onClientDisconnect: (fn) => { disconnectHooks.push(fn); return () => {} },
    },
    events,
    client: FAKE_CLIENT,
    call: (name, msg, ctx = {}) => {
      const fn = handlers.get(name)
      if (!fn) throw new Error('no handler registered for ' + name)
      return fn(msg, { id: null, signal: null, client: FAKE_CLIENT, ...ctx })
    },
    // Drives what a real pipe close drives, so a test can assert the cleanup a departing client
    // triggers without building a second router.
    disconnect: (client = FAKE_CLIENT) => { for (const fn of disconnectHooks) fn(client) },
    // A seam for a test that has to act WHILE a handler is running: the data layer's scan passes are
    // synchronous, so a frame they push is the only moment a test can interleave with them.
    onEmit: (fn) => { emitListeners.add(fn); return () => emitListeners.delete(fn) },
    emitted: (type) => events.filter((e) => e.type === type),
    lastStatus: (shareId) => {
      const matches = events.filter((e) => e.type === 'event:owned-folder-mount-status' &&
        (shareId === undefined || e.payload?.shareId === shareId))
      return matches.length ? matches[matches.length - 1].payload.status : null
    },
  }
}
