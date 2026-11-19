// The thread side of main.mjs: hashes the shared block with the engine's chunk hash, which loads
// a native addon inside the thread, and answers on the channel.
import Channel from 'bare-channel'
import { hashChunk } from '../../../src/shared/transfer/overlay/engine/chunker.js'

const { handle, shared } = Bare.Thread.self.data
const port = Channel.from(handle).connect()
await port.write({ hash: hashChunk(Buffer.from(shared)) })
await port.close()
