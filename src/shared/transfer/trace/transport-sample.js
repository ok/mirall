// What one connection's transport reports about itself: the udx stream's congestion and loss
// figures and its socket's kernel drop count and buffer sizes. Every read is guarded, because a
// stream that is closing, or a transport that is not udx, answers some of them with a throw or
// with nothing; a figure that cannot be read is left out.
//
// Pure, so a unit test drives it under Node with a stand-in stream.

const STREAM_FIELDS = Object.freeze({
  mtu: 'mtu',
  rtt: 'rtt',
  cwnd: 'cwnd',
  inflight: 'inflight',
  rto: 'rtoCount',
  rtoLifetime: 'lifetimeRtoCount',
  retransmits: 'retransmits',
  fastRecoveries: 'fastRecoveries',
  bbrState: 'bbrState',
  bbrBandwidth: 'bbrBandwidth',
  rxBytes: 'bytesReceived',
  txBytes: 'bytesTransmitted',
  rxPackets: 'packetsReceived',
  txPackets: 'packetsTransmitted',
})

function read(take) {
  try {
    const value = take()
    return Number.isFinite(value) ? value : undefined
  } catch {
    return undefined
  }
}

/** @param {object | null | undefined} rawStream the connection's transport stream @returns {Record<string, number>} */
export function transportSample(rawStream) {
  const sample = {}
  if (!rawStream) return sample
  for (const [name, getter] of Object.entries(STREAM_FIELDS)) {
    const value = read(() => rawStream[getter])
    if (value !== undefined) sample[name] = value
  }
  const socket = rawStream.socket
  if (!socket) return sample
  const socketReads = {
    kernelDrops: () => socket.packetsDroppedByKernel,
    recvBuffer: () => socket.getRecvBufferSize(),
    sendBuffer: () => socket.getSendBufferSize(),
  }
  for (const [name, take] of Object.entries(socketReads)) {
    const value = read(take)
    if (value !== undefined) sample[name] = value
  }
  return sample
}
