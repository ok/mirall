// The kernel buffer sizes of the UDP socket a connection's transport runs on, set to the values a
// test run file names. The socket is the one the connection actually uses, whichever the DHT picked
// for it, and several connections may share it, so the same size is simply set again. The kernel
// may grant less than asked; the transfer trace records what the socket then reports. A transport
// that is not udx, or a socket already closing, is left alone.
//
// Pure, so a unit test drives it under Node with a stand-in stream.

/** @param {object | null | undefined} rawStream @param {{ recvBufferBytes?: number, sendBufferBytes?: number }} sizes */
export function applySocketBuffers(rawStream, { recvBufferBytes, sendBufferBytes }) {
  const socket = rawStream?.socket
  if (!socket) return
  if (recvBufferBytes) try { socket.setRecvBufferSize(recvBufferBytes) } catch {}
  if (sendBufferBytes) try { socket.setSendBufferSize(sendBufferBytes) } catch {}
}
