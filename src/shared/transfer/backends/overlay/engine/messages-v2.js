// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/messages-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// Codecs for the hyper-overlay/v2 channel, and the slot table that is its wire order; the eight
// retired slots carry no codec. All use compact-encoding codecs with preencode/encode/decode.

import c from 'compact-encoding'

// The channel's message slots, in wire order. protomux routes a frame by the POSITION its message
// was registered at, so this order is the contract with every released peer: never remove, insert
// or reorder a row, and append new messages at the end. A retired slot keeps its position with no
// codec and no handler — the protocol registers it as raw bytes, which never decode, so no frame on
// it can throw and receiving one does nothing. Nothing sends on a retired slot.
export const SLOTS = Object.freeze([
  { name: 'syncState', retired: true },
  { name: 'fileOffer', retired: true },
  { name: 'fileRequest', retired: true },
  { name: 'chunkHashes', retired: false },
  { name: 'chunkNeed', retired: false },
  { name: 'chunkData', retired: false },
  { name: 'chunkCancel', retired: true },
  { name: 'transferComplete', retired: true },
  { name: 'conflict', retired: true },
  { name: 'treeRequest', retired: true },
  { name: 'treeResponse', retired: true },
  { name: 'contentRequest', retired: false },
  { name: 'transferControl', retired: false },
  { name: 'transferProgress', retired: false },
  { name: 'keepAlive', retired: false }
])


// ── Helpers ───────────────────────────────────────────────────

function toBuffer32 (hashOrBuf) {
  if (Buffer.isBuffer(hashOrBuf)) return hashOrBuf
  return Buffer.from(hashOrBuf, 'hex')
}

// Encode/decode an array of { hash (32-byte hex), length (uint) }
const chunkInfoArray = {
  preencode (state, arr) {
    c.uint32.preencode(state, arr.length)
    for (const item of arr) {
      state.end += 32
      c.uint.preencode(state, item.length)
    }
  },
  encode (state, arr) {
    c.uint32.encode(state, arr.length)
    for (const item of arr) {
      toBuffer32(item.hash).copy(state.buffer, state.start, 0, 32)
      state.start += 32
      c.uint.encode(state, item.length)
    }
  },
  decode (state) {
    const len = c.uint32.decode(state)
    const arr = []
    for (let i = 0; i < len; i++) {
      const hash = state.buffer.subarray(state.start, state.start + 32).toString('hex')
      state.start += 32
      const length = c.uint.decode(state)
      arr.push({ hash, length })
    }
    return arr
  }
}

// Encode/decode an array of uints
const uintArray = {
  preencode (state, arr) {
    c.uint32.preencode(state, arr.length)
    for (const v of arr) c.uint.preencode(state, v)
  },
  encode (state, arr) {
    c.uint32.encode(state, arr.length)
    for (const v of arr) c.uint.encode(state, v)
  },
  decode (state) {
    const len = c.uint32.decode(state)
    const arr = []
    for (let i = 0; i < len; i++) arr.push(c.uint.decode(state))
    return arr
  }
}

// ── Handshake ─────────────────────────────────────────────────

// [mirall] what a peer is taken to speak when its open frame carries no handshake bytes at all.
// Every build before the handshake reached the wire ran this same v2 message set, so the version
// is one below VERSION: raising the minimum to 2 retires exactly those builds and nothing else.
// Capabilities are empty, so a cap-gated behaviour is off against them.
export const UNANNOUNCED_HANDSHAKE = Object.freeze({ version: 1, capabilities: 0 })

export const handshake = {
  preencode (state, m) {
    c.uint8.preencode(state, m.version)
    c.uint8.preencode(state, m.capabilities)
  },
  encode (state, m) {
    c.uint8.encode(state, m.version)
    c.uint8.encode(state, m.capabilities)
  },
  decode (state) {
    // [mirall] this decoder must NEVER throw. protomux hands any peer's open-frame remainder
    // straight to it and destroys the whole mux — every channel on the socket, including
    // mirall/handshake and corestore replication — if it does, which any swarm peer could then
    // trigger with one short frame. So every field is bounds-checked and falls back to the
    // unannounced default: an absent tail is a pre-handshake build (v1.8.0/v1.9.0), a truncated
    // one is garbage, and both read as "announced nothing" rather than taking the socket down.
    // Reading field-by-field also keeps the wire format append-only-extensible: a future peer
    // that adds a third byte stays decodable by today's builds.
    const version = state.start < state.end ? c.uint8.decode(state) : UNANNOUNCED_HANDSHAKE.version
    const capabilities = state.start < state.end ? c.uint8.decode(state) : UNANNOUNCED_HANDSHAKE.capabilities
    return { version, capabilities }
  }
}

// ── Chunk transfer (slots 3-5) ────────────────────────────────

// Message 3: chunk-hashes — chunk hash list for a requested file
//
// [mirall] §4.12 — `more` (paging flag) is appended last. A very large file's
// chunk list serializes past the 16 MiB-1 Noise frame limit
// (@hyperswarm/secret-stream MAX_ATOMIC_WRITE), so the protocol splits it into
// several chunkHashes frames: every page but the last sets more:1, the final
// page sets more:0. The receiver concatenates pages (in arrival order, keyed by
// path) before dispatching. Appended last so a pre-paging peer that omits it
// decodes more:0 — i.e. as a single, complete page (back-compatible).
export const chunkHashes = {
  preencode (state, m) {
    c.string.preencode(state, m.path)
    c.uint8.preencode(state, m.tier)
    chunkInfoArray.preencode(state, m.chunks)
    c.uint8.preencode(state, m.more || 0)
  },
  encode (state, m) {
    c.string.encode(state, m.path)
    c.uint8.encode(state, m.tier)
    chunkInfoArray.encode(state, m.chunks)
    c.uint8.encode(state, m.more || 0)
  },
  decode (state) {
    const path = c.string.decode(state)
    const tier = c.uint8.decode(state)
    const chunks = chunkInfoArray.decode(state)
    // A frame from a pre-paging peer has no trailing byte → more:0.
    const more = state.start < state.end ? c.uint8.decode(state) : 0
    return { path, tier, chunks, more }
  }
}

// Message 4: chunk-need — tell sender which chunks to send
export const chunkNeed = {
  preencode (state, m) {
    c.string.preencode(state, m.path)
    uintArray.preencode(state, m.indices)
  },
  encode (state, m) {
    c.string.encode(state, m.path)
    uintArray.encode(state, m.indices)
  },
  decode (state) {
    return {
      path: c.string.decode(state),
      indices: uintArray.decode(state)
    }
  }
}

// Message 5: chunk-data — send chunk bytes
export const chunkData = {
  preencode (state, m) {
    c.string.preencode(state, m.path)
    c.uint.preencode(state, m.index)
    c.buffer.preencode(state, m.data)
  },
  encode (state, m) {
    c.string.encode(state, m.path)
    c.uint.encode(state, m.index)
    c.buffer.encode(state, m.data)
  },
  decode (state) {
    return {
      path: c.string.decode(state),
      index: c.uint.decode(state),
      data: c.buffer.decode(state)
    }
  }
}

// ── Content fetch and serve control (slots 11-14) ─────────────

// Message 11: content-request — fetch a file by its content hash (not path)
// Sender locates any local file matching the hash and serves its chunks.
// [mirall] : `from` carries the requester's profile-key (hex) so the
// holder's serveAuthorizer can authenticate the asker. Appended last → an
// overlay peer that predates this field decodes '' (empty), never crashes.
export const contentRequest = {
  preencode (state, m) {
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.buffer.preencode(state, m.chunksHave || Buffer.alloc(0))
    c.string.preencode(state, m.from || '')
  },
  encode (state, m) {
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.buffer.encode(state, m.chunksHave || Buffer.alloc(0))
    c.string.encode(state, m.from || '')
  },
  decode (state) {
    return {
      contentHash: c.buffer.decode(state).toString('hex'),
      chunksHave: c.buffer.decode(state),
      from: c.string.decode(state)
    }
  }
}

// Message 12: transfer-control — downloader→holder pause/stop notice for a
// content-addressed fetch. state: 0 = paused, 1 = stopped. Appended last so a
// holder that predates this never registers slot 12 and silently ignores it.
export const transferControl = {
  preencode (state, m) {
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.uint8.preencode(state, m.state)
  },
  encode (state, m) {
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.uint8.encode(state, m.state)
  },
  decode (state) {
    return {
      contentHash: c.buffer.decode(state).toString('hex'),
      state: c.uint8.decode(state)
    }
  }
}

// Message 13: transfer-progress — downloader→holder one-shot have-baseline for a
// resumed content-addressed fetch. `have` = bytes the downloader already holds on
// disk at resume, so the holder's "who is downloading" bar reflects the downloader's
// TRUE completion, not only the bytes it re-serves. Appended last so a holder that
// predates this never registers slot 13 and silently ignores it.
export const transferProgress = {
  preencode (state, m) {
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.uint.preencode(state, m.have || 0)
  },
  encode (state, m) {
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.uint.encode(state, m.have || 0)
  },
  decode (state) {
    return {
      contentHash: c.buffer.decode(state).toString('hex'),
      have: c.uint.decode(state)
    }
  }
}

// Message 14: keep-alive — holder→downloader liveness while a serve loop is parked on its
// own UPLOAD cap. Time spent waiting on that cap puts nothing on the wire, so past the
// downloader's no-progress watchdog a healthy paced holder is indistinguishable from one
// that has wedged. `index` is the chunk being paid for, so the receiver can re-arm only a
// fetch this peer actually owes bytes on. Appended last so a holder that predates this
// never registers slot 14 and silently ignores it.
export const keepAlive = {
  preencode (state, m) {
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.uint.preencode(state, m.index || 0)
  },
  encode (state, m) {
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.uint.encode(state, m.index || 0)
  },
  decode (state) {
    return {
      contentHash: c.buffer.decode(state).toString('hex'),
      index: c.uint.decode(state)
    }
  }
}
