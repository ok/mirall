import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import c from 'compact-encoding'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'

// A hand-built attacker peer (NOT the worker): joins a space topic with an arbitrary
// keypair and speaks the raw `mirall/handshake` channel, so a test can send forged
// frames (spoofed profileKey, missing/garbage binding) and observe what the real
// worker sends back. Used to exercise the MIR-03 identity-binding rejections.
export async function rawPeer (t, { bootstrap, topicHex, keyPair = crypto.keyPair() }) {
  const swarm = new Hyperswarm({ bootstrap, keyPair })
  const frames = []
  const waiters = []
  let sender = null
  let markConnected = null
  const connected = new Promise((resolve) => { markConnected = resolve })

  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    const mux = Protomux.from(socket)
    const channel = mux.createChannel({ protocol: 'mirall/handshake' })
    const message = channel.addMessage({
      encoding: c.string,
      onmessage (str) {
        let m
        try { m = JSON.parse(str) } catch { return }
        frames.push(m)
        for (const w of waiters.splice(0)) w(m)
      },
    })
    channel.open()
    sender = (obj) => { try { message.send(JSON.stringify(obj)) } catch {} }
    markConnected()
  })

  swarm.join(b4a.from(topicHex, 'hex'), { client: true, server: true })
  await swarm.flush()
  t.teardown(() => swarm.destroy())

  return {
    keyPair,
    frames,
    waitConnected: () => connected,
    send: (obj) => sender?.(obj),
    waitFrame: (pred = () => true, ms = 8000) => new Promise((resolve, reject) => {
      const found = frames.find(pred)
      if (found) return resolve(found)
      const to = setTimeout(() => reject(new Error('no matching frame')), ms)
      waiters.push((m) => { if (pred(m)) { clearTimeout(to); resolve(m) } })
    }),
  }
}
