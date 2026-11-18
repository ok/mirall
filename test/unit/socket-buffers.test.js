import test from 'brittle'
import { applySocketBuffers } from '../../src/shared/transfer/socket-buffers.js'

function socketStub() {
  const set = {}
  return { set, setRecvBufferSize(n) { set.recv = n }, setSendBufferSize(n) { set.send = n } }
}

test('the named sizes are set on the socket the connection runs on, and only those', (t) => {
  const both = socketStub()
  applySocketBuffers({ socket: both }, { recvBufferBytes: 4194304, sendBufferBytes: 2097152, inflightCap: 4 })
  t.alike(both.set, { recv: 4194304, send: 2097152 })

  const one = socketStub()
  applySocketBuffers({ socket: one }, { recvBufferBytes: 4194304 })
  t.alike(one.set, { recv: 4194304 }, 'a size the file did not name is not touched')

  const none = socketStub()
  applySocketBuffers({ socket: none }, {})
  t.alike(none.set, {}, 'no lever, no call')
})

test('a transport without a socket, or one that refuses, is left alone', (t) => {
  t.execution(() => applySocketBuffers(null, { recvBufferBytes: 4194304 }))
  t.execution(() => applySocketBuffers({ socket: null }, { recvBufferBytes: 4194304 }))
  const closing = { set: {}, setRecvBufferSize() { throw new Error('Socket not active') }, setSendBufferSize(n) { this.set.send = n } }
  t.execution(() => applySocketBuffers({ socket: closing }, { recvBufferBytes: 4194304, sendBufferBytes: 2097152 }))
  t.alike(closing.set, { send: 2097152 }, 'the other size is still set')
})
