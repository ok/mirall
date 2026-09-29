import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

// A hand-built attacker peer (NOT the worker): joins a space topic with an arbitrary
// keypair and speaks the raw `mirall/handshake` channel, so a test can send forged
// frames (spoofed profileKey, missing/garbage binding) and observe what the real
// worker sends back. Used to exercise the MIR-03 identity-binding rejections. Given a
// `store`, it also replicates it, so the worker can read bees the attacker authored.
export async function rawPeer(t, { bootstrap, topicHex, keyPair = crypto.keyPair(), store = null }) {
  const swarm = new Hyperswarm({ bootstrap, keyPair })
  const frames = []
  const waiters = new Set()
  const senders = new Set()
  const connectionWaiters = new Set()
  let remoteKey = null
  const settleConnectionWaiters = () => {
    for (const w of connectionWaiters) if (senders.size >= w.n) { connectionWaiters.delete(w); w.resolve() }
  }

  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    remoteKey = socket.remotePublicKey
    if (store) store.replicate(socket)
    const mux = Protomux.from(socket)
    const channel = mux.createChannel({ protocol: 'mirall/handshake' })
    const message = channel.addMessage({
      encoding: c.string,
      onmessage(str) {
        let m
        try { m = JSON.parse(str) } catch { return }
        frames.push(m)
        for (const w of waiters) w(m)
      },
    })
    channel.open()
    const sender = (obj) => { try { message.send(JSON.stringify(obj)) } catch {} }
    senders.add(sender)
    socket.on('close', () => senders.delete(sender))
    settleConnectionWaiters()
  })

  swarm.join(b4a.from(topicHex, 'hex'), { client: true, server: true })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  function waitConnections(n) {
    return new Promise((resolve) => {
      connectionWaiters.add({ n, resolve })
      settleConnectionWaiters()
    })
  }

  return {
    keyPair,
    frames,
    // The Noise key of the worker on the most recent socket: the key its topic refs are bound to.
    remotePublicKey: () => remoteKey,
    waitConnected: () => waitConnections(1),
    // Resolves once `n` sockets are open at the same time: a peer on a topic with several workers
    // must reach each of them.
    waitConnections,
    openSockets: () => senders.size,
    // Every open socket gets the frame.
    send: (obj) => { for (const sender of senders) sender(obj) },
    waitFrame: (pred = () => true, ms = 8000) => new Promise((resolve, reject) => {
      const found = frames.find(pred)
      if (found) return resolve(found)
      // A waiter stays armed through frames that do not match it.
      const waiter = (m) => {
        if (!pred(m)) return
        clearTimeout(to)
        waiters.delete(waiter)
        resolve(m)
      }
      const to = setTimeout(() => { waiters.delete(waiter); reject(new Error('no matching frame')) }, ms)
      waiters.add(waiter)
    }),
  }
}
