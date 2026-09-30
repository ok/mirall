// Byte builders for the retired hyper-overlay/v2 slots, as v1.11.x encodes them (pinned by
// test/fixtures/overlay-wire/v1.json). Tests use them to play an old or a hostile peer.
import c from 'compact-encoding'
import { SLOTS } from '../../src/shared/transfer/overlay/engine/wire/slots.js'

const h32 = (x) => (Buffer.isBuffer(x) ? x : Buffer.from(x, 'hex'))

function build(fields) {
  const state = { start: 0, end: 0, buffer: null }
  for (const [enc, v] of fields) enc.preencode(state, v)
  state.buffer = Buffer.allocUnsafe(state.end)
  for (const [enc, v] of fields) enc.encode(state, v)
  return state.buffer
}

// A tree entry: kind u8, exec u8, name string, childHash as 32 raw bytes (no length prefix), size uint.
const treeEntries = {
  preencode(state, arr) {
    c.uint32.preencode(state, arr.length)
    for (const e of arr) {
      c.uint8.preencode(state, e.kind)
      c.uint8.preencode(state, e.exec || 0)
      c.string.preencode(state, e.name)
      state.end += 32
      c.uint.preencode(state, e.size || 0)
    }
  },
  encode(state, arr) {
    c.uint32.encode(state, arr.length)
    for (const e of arr) {
      c.uint8.encode(state, e.kind)
      c.uint8.encode(state, e.exec || 0)
      c.string.encode(state, e.name)
      h32(e.childHash).copy(state.buffer, state.start, 0, 32)
      state.start += 32
      c.uint.encode(state, e.size || 0)
    }
  },
}

export const LEGACY_FRAMES = {
  syncState: ({ feedKey, localSeq = 0, remoteSeq = 0 }) => build([[c.buffer, h32(feedKey)], [c.uint, localSeq], [c.uint, remoteSeq]]),
  fileOffer: ({ path, contentHash, size = 0, mtime = 0, op = 0 }) => build([[c.string, path], [c.buffer, h32(contentHash)], [c.uint, size], [c.uint, mtime], [c.uint8, op]]),
  fileRequest: ({ path, contentHash, chunksHave = null }) => build([[c.string, path], [c.buffer, h32(contentHash)], [c.buffer, chunksHave || Buffer.alloc(0)]]),
  chunkCancel: ({ path }) => build([[c.string, path]]),
  transferComplete: ({ path, contentHash }) => build([[c.string, path], [c.buffer, h32(contentHash)]]),
  conflict: ({ path, myHash, theirHash, ancestorHash = null }) => build([[c.string, path], [c.buffer, h32(myHash)], [c.buffer, h32(theirHash)], [c.buffer, ancestorHash ? h32(ancestorHash) : Buffer.alloc(32)]]),
  treeRequest: ({ hash, nonce = 0 }) => build([[c.buffer, h32(hash)], [c.uint, nonce]]),
  treeResponse: ({ hash, entries = [], more = 0, nonce = 0 }) => build([[c.buffer, h32(hash)], [treeEntries, entries], [c.uint8, more], [c.uint, nonce]]),
}

const SLOT_ID = Object.fromEntries(SLOTS.map(({ name }, id) => [name, id]))

// Send a retired-slot frame from an engine peer record, in the released bytes. `channel.messages` is
// protomux's per-channel slot array: a test-only reach-in, since the engine registers no sender there.
export function sendLegacy(peer, name, value) {
  return peer.channel.messages[SLOT_ID[name]].send(LEGACY_FRAMES[name](value))
}
