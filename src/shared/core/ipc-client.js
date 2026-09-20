// One connected peer on the router: its pipe, and the requests it has outstanding. Request ids are
// minted by the CALLER and every caller starts at 1, so the id alone is not a key — the owning
// client is the other half. Holding the in-flight map on the client IS the namespacing: there is no
// composite key to build, parse or get wrong.
export function createClient(id, pipe, { trust = 'host' } = {}) {
  let closed = false
  return {
    id,
    // Who is on the other end. 'host' is the process that spawned us (main, relaying its renderer):
    // the only kind that exists until the daemon listens on a socket, and the only kind that may
    // stop or restart the worker. Declared now so that rule has something to read.
    trust,
    inFlight: new Map(),
    get closed() { return closed },
    // Never throws: a handler whose client left mid-request still runs to completion and answers,
    // and that answer has nowhere to go. Dropped here rather than surfacing as a write error inside
    // the crash backstop's fault window.
    write(line) {
      if (closed) return false
      try { pipe.write(line); return true } catch { return false }
    },
    // Both directions stay behind the client, so nothing outside has to hold a raw pipe and
    // remember which client it belonged to.
    onData(fn) { pipe.on('data', fn) },
    close() { closed = true },
  }
}

// Who is connected, how a line reaches them, and what happens when one joins or goes. The router
// owns what a frame MEANS; this owns the set it arrives from and goes out to, which is the half
// that grows when a second client can exist.
//
// Ids are minted per registry rather than per module: a module-level counter would leak across the
// hundreds of routers the unit suite builds and make "client 1" mean something different in every
// file.
//
// `bindReader` and `onRemoved` come from the router because they are the two halves it still owns:
// reading a client's frames, and abandoning the work it left behind.
export function createClientRegistry({ bindReader, onRemoved, log }) {
  const clients = new Map()
  const disconnectHooks = new Set()
  let nextId = 1
  let greeter = null
  let live = false

  // What a client is told when it joins a live router. The boot-once events used to fire exactly
  // once, so a client attaching afterwards never received them at all. A greeter is RECOMPUTED per
  // client, so "attached at boot" and "attached an hour later" converge on the same current state;
  // replaying the boot-time value instead would push a stale spaces list over a fresher one.
  function greet(client) {
    if (!greeter) return
    Promise.resolve().then(() => greeter(client))
      .catch((err) => log.warn('greeting failed:', err.message))
  }

  return {
    attach(pipe, opts) {
      const client = createClient(nextId++, pipe, opts)
      clients.set(client.id, client)
      bindReader(client)
      // Only once the router is live: before then there is nothing true to say yet, and goLive()
      // greets everyone who attached by that point.
      if (live) greet(client)
      return client
    },

    // Returns what the departing client left in flight. A second detach finds nothing to remove and
    // is a no-op, rather than a second round of aborts and disconnect hooks.
    detach(client, reason) {
      if (!client || !clients.delete(client.id)) return 0
      client.close()
      const aborted = onRemoved(client, reason)
      for (const fn of disconnectHooks) {
        try { fn(client) } catch (err) { log.warn('disconnect hook failed:', err.message) }
      }
      return aborted
    },

    onAttach(fn) { greeter = fn },

    onDisconnect(fn) {
      disconnectHooks.add(fn)
      return () => disconnectHooks.delete(fn)
    },

    goLive() {
      live = true
      for (const client of clients.values()) greet(client)
    },

    // A client object passes through; an id is looked up. Either may name a client that has since
    // gone, and the caller treats that as a silent no-op.
    resolve(to) {
      return typeof to === 'object' ? to : clients.get(to) ?? null
    },
    all: () => [...clients.values()],
    size: () => clients.size,
  }
}
