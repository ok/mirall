import Hyperswarm from 'hyperswarm'
import Protomux from 'protomux'
import b4a from 'b4a'
import crypto from 'hypercore-crypto'
import { handshake } from '../../src/shared/transfer/backends/overlay/engine/wire/messages.js'
import { SLOTS } from '../../src/shared/transfer/backends/overlay/engine/wire/slots.js'
import { LEGACY_FRAMES } from './legacy-overlay-frames.js'

// A hand-built peer on a space's CONTENT topic (not the worker): it never sends a content-hello,
// it only opens the raw hyper-overlay/v2 channel. It records what the worker sends it and can push
// chunk maps or any other slot's frame. The topic derivation mirrors content-swarm.js's deriveContentTopic.
const CONTENT_TOPIC_LABEL = b4a.from('mirall/content-plane/v1')
const contentTopic = (topicHex) => crypto.hash(b4a.concat([b4a.from(topicHex, 'hex'), CONTENT_TOPIC_LABEL]))

// protomux dispatches by position, so the slots follow the engine's slot table. A retired slot is
// raw bytes both ways: `send` writes the released encoding, and a frame received on it is kept raw.

export async function rawContentPeer(t, { bootstrap, topicHex, answer = null }) {
  const swarm = new Hyperswarm({ bootstrap })
  const seen = { syncState: [], contentRequest: [], transferControl: [], transferProgress: [] }
  const channels = []
  swarm.on('connection', (socket) => {
    socket.on('error', () => {})
    const mux = Protomux.from(socket)
    const channel = mux.createChannel({ protocol: 'hyper-overlay/v2', id: null, handshake })
    const msgs = {}
    for (const slot of SLOTS) {
      const name = slot.name
      msgs[name] = channel.addMessage({
        encoding: slot.codec,
        onmessage: (msg) => {
          seen[name]?.push(msg)
          if (name === 'contentRequest' && answer) msgs.chunkHashes.send(answer(msg.contentHash))
        },
      })
    }
    channel.open({ version: 2, capabilities: 0x03 })
    channels.push(msgs)
  })
  swarm.join(contentTopic(topicHex), { client: true, server: true })
  await swarm.flush()
  t.teardown(() => swarm.destroy())
  return {
    seen,
    connections: () => channels.length,
    push: (msg) => { for (const ch of channels) { try { ch.chunkHashes.send(msg) } catch {} } },
    send: (name, msg) => {
      const frame = LEGACY_FRAMES[name] ? LEGACY_FRAMES[name](msg) : msg
      for (const ch of channels) { try { ch[name].send(frame) } catch {} }
    },
  }
}
