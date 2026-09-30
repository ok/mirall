import test from 'brittle'
import { VERSION, MIN_VERSION, CAPABILITIES, CAP_LOCAL_FILES, CAP_ADAPTIVE_CHUNKS } from '../../src/shared/transfer/overlay/engine/wire/slots.js'
import { handshake } from '../../src/shared/transfer/overlay/engine/wire/messages.js'
import { makeProtocol } from '../helpers/overlay-engine.js'

// The channel's identity on the wire. A released peer pairs channels by protocol name and id, and
// reads the version and capabilities from the open frame: any change here is a wire change.
test('the channel opens as hyper-overlay/v2 with a null id and the released handshake', (t) => {
  let created = null
  let opened = null
  const mux = {
    createChannel(opts) {
      created = opts
      return { addMessage() { return { send() {} } }, open(hs) { opened = hs }, close() {} }
    },
  }
  makeProtocol(null).attach(mux)
  t.is(created.protocol, 'hyper-overlay/v2')
  t.is(created.id, null)
  t.is(created.handshake, handshake, 'the open frame carries the handshake codec')
  t.alike(opened, { version: 2, capabilities: 0x03 })
})

test('version and capability constants are frozen', (t) => {
  t.is(VERSION, 2)
  t.is(MIN_VERSION, 1)
  t.is(CAP_LOCAL_FILES, 0x01)
  t.is(CAP_ADAPTIVE_CHUNKS, 0x02)
  t.is(CAPABILITIES, 0x03)
})
