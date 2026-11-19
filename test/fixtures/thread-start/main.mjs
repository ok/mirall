// Starts one thread through bare-thread, hands it a shared block over bare-channel, and prints
// one JSON line: the Bare version, the hash the thread computed and the hash computed here. It
// exits itself, because the sidecar's Bare stays up for as long as its host pipe is open.
import Thread from 'bare-thread'
import Channel from 'bare-channel'
import { hashChunk } from '../../../src/shared/transfer/overlay/engine/chunker.js'

const shared = new SharedArrayBuffer(64 * 1024)
const block = Buffer.from(shared)
for (let i = 0; i < block.length; i++) block[i] = (i * 31) & 0xff

const channel = new Channel()
const entry = new URL('./hash-thread.mjs', import.meta.url).pathname
const thread = new Thread(entry, { data: { handle: channel.handle, shared } })
const port = channel.connect()

let threadHash = null
for await (const msg of port) { threadHash = msg.hash; break }
await port.close()
thread.join()

console.log(JSON.stringify({ bare: Bare.version, threadHash, mainHash: hashChunk(block) }))
Bare.exit(0)
