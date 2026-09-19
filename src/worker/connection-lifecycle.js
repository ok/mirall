// What the worker does when a client goes away. A closed pipe is a disconnected CLIENT, not a dead
// process: the client is detached — its in-flight work aborted, its registries dropped — and only
// then is the separate question asked, whether there is any point in staying up.
//
// That separation is the change. The answer today is still "stop", and deliberately so: until the
// worker listens on a socket there is no way for a new client to arrive, so a worker with none is
// an unreachable orphan holding the store lock, and an orphan breaks the next launch. Pipe close is
// also the only guard against a main process that died hard — process.on('exit') does not run on a
// SIGKILL. A daemon that can accept clients passes canAcceptClients and lingers instead, and that
// is a one-boolean change rather than an edit to the disconnect path.

/**
 * @param {{ clients: number, bootComplete: boolean, canAcceptClients: boolean }} state
 * @returns {'stay' | 'linger' | 'stop'}
 */
export function afterLastClient({ clients, bootComplete, canAcceptClients }) {
  if (clients > 0) return 'stay'
  // A boot that never completed always stops: the parent died during startup, and nothing will
  // ever send the bootstrap frame this worker is still waiting for.
  if (!bootComplete) return 'stop'
  return canAcceptClients ? 'linger' : 'stop'
}

export function bindConnectionLifecycle({ pipe, ipc, client, isBootComplete, canAcceptClients = false, stop }) {
  let gone = false
  // end, close and error all describe the same event and routinely arrive together.
  const onGone = (reason) => {
    if (gone) return
    gone = true
    ipc.detach(client, reason)
    const verdict = afterLastClient({
      clients: ipc.clientCount(),
      bootComplete: isBootComplete(),
      canAcceptClients,
    })
    if (verdict === 'stop') stop(reason)
  }
  pipe.on('end', () => onGone('ipc-end'))
  pipe.on('close', () => onGone('ipc-close'))
  pipe.on('error', (err) => onGone('ipc-error: ' + (err && err.message ? err.message : err)))
}
