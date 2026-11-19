// A stand-in for the engine's hash-thread entry whose content thread ends at its first block, the
// way a thread that died mid-file looks from the worker thread. The chunks thread never answers.
import Channel from 'bare-channel'

const { handle, role } = Bare.Thread.self.data
const port = Channel.from(handle).connect()
for await (const msg of port) {
  if (role === 'content' && msg.slot !== undefined) break
}
await port.close()
