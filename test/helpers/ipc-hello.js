// The introduction every client owes the router before any other frame it sends is honoured. One
// helper rather than a literal per file: the frame is contract vocabulary, and a copy in each suite
// is a copy that keeps the old wire alive after the next bump.
import { FRAME, IPC_PROTOCOL_VERSION, IPC_PROTOCOL_MIN_SUPPORTED } from '../../src/shared/contract/ipc-frames.js'

export function helloFrame(over = {}) {
  return {
    type: FRAME.HELLO,
    protocolVersion: IPC_PROTOCOL_VERSION,
    protocolMin: IPC_PROTOCOL_MIN_SUPPORTED,
    protocolMax: IPC_PROTOCOL_VERSION,
    client: { kind: 'test', name: 'unit-suite', version: '0.0.0-test' },
    ...over,
  }
}

// Feeds the hello down a pipe double and returns the ack, leaving the pipe's record of what was
// written exactly as it was. `feed` covers the unit suites, `send` the integration ones — the two
// spellings the fakes already use — and a raw emitter is driven directly.
//
// The ACK, and only the ack, is taken back off `written`, because a suite about requests is
// asserting on responses: a handshake frame in every such assertion would be the handshake's cost
// charged to every test that is not about it. A hello carrying a cursor is replayed before it is
// acked, and those frames are the caller's to see.
export function sayHello(pipe, over = {}) {
  const before = pipe.written ? pipe.written.length : 0
  const frame = helloFrame(over)
  if (typeof pipe.feed === 'function') pipe.feed(frame)
  else if (typeof pipe.send === 'function') pipe.send(frame)
  else pipe.emit('data', Buffer.from(JSON.stringify(frame) + '\n'))
  if (!pipe.written) return null
  const at = pipe.written.findIndex((l, i) => i >= before && JSON.parse(l).type === FRAME.HELLO_ACK)
  if (at === -1) return null
  return JSON.parse(pipe.written.splice(at, 1)[0])
}
