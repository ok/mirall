// In-process `ipc` double for Tier-2 single-store tests. Records emitted events
// so tests can assert on them; handlers are accepted but not invoked.
export function createFakeIpc () {
  const events = []
  return {
    ipc: {
      emit: (type, payload) => { events.push({ type, payload }) },
      handle: () => {},
      respond: () => {},
      start: () => {},
    },
    events,
    emitted: (type) => events.filter((e) => e.type === type),
    lastStatus: (shareId) => {
      const matches = events.filter((e) => e.type === 'event:owned-folder-mount-status' &&
        (shareId === undefined || e.payload?.shareId === shareId))
      return matches.length ? matches[matches.length - 1].payload.status : null
    },
  }
}
