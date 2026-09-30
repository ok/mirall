// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/messages-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// Codecs for the hyper-overlay/v2 channel's live messages. Their order on the wire is the slot
// table in slots.js; the retired slots carry no codec.

import c from 'compact-encoding'
import b4a from 'b4a'

// transferControl states, downloader → holder.
export const CONTROL_PAUSED = 0
export const CONTROL_STOPPED = 1

// ── Helpers ───────────────────────────────────────────────────

function toBuffer32(hashOrBuf) {
  if (Buffer.isBuffer(hashOrBuf)) return hashOrBuf
  return Buffer.from(hashOrBuf, 'hex')
}

const hexOf = (buf) => b4a.toString(buf, 'hex')

// An array of { hash (32-byte hex), length (uint) }.
const chunkInfoArray = {
  preencode(state, arr) {
    c.uint32.preencode(state, arr.length)
    for (const item of arr) {
      state.end += 32
      c.uint.preencode(state, item.length)
    }
  },
  encode(state, arr) {
    c.uint32.encode(state, arr.length)
    for (const item of arr) {
      toBuffer32(item.hash).copy(state.buffer, state.start, 0, 32)
      state.start += 32
      c.uint.encode(state, item.length)
    }
  },
  decode(state) {
    const len = c.uint32.decode(state)
    const arr = []
    for (let i = 0; i < len; i++) {
      const hash = hexOf(state.buffer.subarray(state.start, state.start + 32))
      state.start += 32
      const length = c.uint.decode(state)
      arr.push({ hash, length })
    }
    return arr
  },
}

const uintArray = {
  preencode(state, arr) {
    c.uint32.preencode(state, arr.length)
    for (const v of arr) c.uint.preencode(state, v)
  },
  encode(state, arr) {
    c.uint32.encode(state, arr.length)
    for (const v of arr) c.uint.encode(state, v)
  },
  decode(state) {
    const len = c.uint32.decode(state)
    const arr = []
    for (let i = 0; i < len; i++) arr.push(c.uint.decode(state))
    return arr
  },
}

// ── Handshake ─────────────────────────────────────────────────

// What a peer is taken to speak when its open frame carries no handshake bytes. Every build
// before the handshake reached the wire ran this same message set, so the version is one below
// VERSION: raising the minimum to 2 retires exactly those builds. Capabilities are empty, so a
// cap-gated behaviour is off against them.
export const UNANNOUNCED_HANDSHAKE = Object.freeze({ version: 1, capabilities: 0 })

export const handshake = {
  preencode(state, m) {
    c.uint8.preencode(state, m.version)
    c.uint8.preencode(state, m.capabilities)
  },
  encode(state, m) {
    c.uint8.encode(state, m.version)
    c.uint8.encode(state, m.capabilities)
  },
  // Never throws: protomux hands any peer's open-frame remainder to this decoder and destroys the
  // whole mux (control channel and replication included) when it throws. Each field is
  // bounds-checked and falls back to the unannounced default, which also keeps the format
  // append-only: a peer that adds a third byte stays decodable.
  decode(state) {
    const version = state.start < state.end ? c.uint8.decode(state) : UNANNOUNCED_HANDSHAKE.version
    const capabilities = state.start < state.end ? c.uint8.decode(state) : UNANNOUNCED_HANDSHAKE.capabilities
    return { version, capabilities }
  },
}

// ── Chunk transfer ────────────────────────────────────────────

// A requested file's chunk list, one page of it. `more` is set on every page but the last (see
// paging.js) and comes last on the wire, so a frame without it decodes as one complete page.
export const chunkHashes = {
  preencode(state, m) {
    c.string.preencode(state, m.path)
    c.uint8.preencode(state, m.tier)
    chunkInfoArray.preencode(state, m.chunks)
    c.uint8.preencode(state, m.more || 0)
  },
  encode(state, m) {
    c.string.encode(state, m.path)
    c.uint8.encode(state, m.tier)
    chunkInfoArray.encode(state, m.chunks)
    c.uint8.encode(state, m.more || 0)
  },
  decode(state) {
    const path = c.string.decode(state)
    const tier = c.uint8.decode(state)
    const chunks = chunkInfoArray.decode(state)
    const more = state.start < state.end ? c.uint8.decode(state) : 0
    return { path, tier, chunks, more }
  },
}

// The chunks a downloader wants sent.
export const chunkNeed = {
  preencode(state, m) {
    c.string.preencode(state, m.path)
    uintArray.preencode(state, m.indices)
  },
  encode(state, m) {
    c.string.encode(state, m.path)
    uintArray.encode(state, m.indices)
  },
  decode(state) {
    return {
      path: c.string.decode(state),
      indices: uintArray.decode(state),
    }
  },
}

export const chunkData = {
  preencode(state, m) {
    c.string.preencode(state, m.path)
    c.uint.preencode(state, m.index)
    c.buffer.preencode(state, m.data)
  },
  encode(state, m) {
    c.string.encode(state, m.path)
    c.uint.encode(state, m.index)
    c.buffer.encode(state, m.data)
  },
  decode(state) {
    return {
      path: c.string.decode(state),
      index: c.uint.decode(state),
      data: c.buffer.decode(state),
    }
  },
}

// ── Content fetch and serve control ───────────────────────────

// Fetch a file by its content hash. `from` is the requester's profile key, which the holder's
// serve gate authenticates; a peer that predates the field sends none and decodes as ''.
export const contentRequest = {
  preencode(state, m) {
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.buffer.preencode(state, m.chunksHave || Buffer.alloc(0))
    c.string.preencode(state, m.from || '')
  },
  encode(state, m) {
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.buffer.encode(state, m.chunksHave || Buffer.alloc(0))
    c.string.encode(state, m.from || '')
  },
  decode(state) {
    return {
      contentHash: hexOf(c.buffer.decode(state)),
      chunksHave: c.buffer.decode(state),
      from: c.string.decode(state),
    }
  },
}

// A downloader paused or stopped a fetch (CONTROL_PAUSED / CONTROL_STOPPED).
export const transferControl = {
  preencode(state, m) {
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.uint8.preencode(state, m.state)
  },
  encode(state, m) {
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.uint8.encode(state, m.state)
  },
  decode(state) {
    return {
      contentHash: hexOf(c.buffer.decode(state)),
      state: c.uint8.decode(state),
    }
  },
}

// The bytes a downloader already holds for a resumed fetch, so the holder's progress bar shows
// the downloader's true completion rather than only the bytes it re-serves.
export const transferProgress = {
  preencode(state, m) {
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.uint.preencode(state, m.have || 0)
  },
  encode(state, m) {
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.uint.encode(state, m.have || 0)
  },
  decode(state) {
    return {
      contentHash: hexOf(c.buffer.decode(state)),
      have: c.uint.decode(state),
    }
  },
}

// Holder → downloader liveness while a serve loop waits on the holder's own upload cap, which
// puts nothing on the wire. `index` is the chunk being paid for, so the downloader re-arms only a
// fetch this peer owes bytes on.
export const keepAlive = {
  preencode(state, m) {
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.uint.preencode(state, m.index || 0)
  },
  encode(state, m) {
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.uint.encode(state, m.index || 0)
  },
  decode(state) {
    return {
      contentHash: hexOf(c.buffer.decode(state)),
      index: c.uint.decode(state),
    }
  },
}
