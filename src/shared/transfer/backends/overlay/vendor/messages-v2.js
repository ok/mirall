/**
 * Wire Protocol Messages for hyper-overlay/v2
 *
 * 13 message types for sync + transfer + trees (0.5a extension):
 *  0-2: Sync messages (state exchange, file offers/requests)
 *  3-8: Transfer messages (chunk hashes, data, completion)
 *  9-11: Tree messages (tree-request, tree-response, content-request)
 *  12: transfer-control (downloader→holder pause/stop notice)
 *
 * Messages 9-12 are backward-compatible additions — peers without
 * this code simply don't register the corresponding protomux slots, and
 * senders see no receiver for those messages. File-level sync (0-8)
 * keeps working unchanged.
 *
 * All use compact-encoding codecs with preencode/encode/decode.
 */

import c from 'compact-encoding'

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
    return {
      version: c.uint8.decode(state),
      capabilities: c.uint8.decode(state)
    }
  }
}

// ── Sync Messages (0-2) ──────────────────────────────────────

// Message 0: sync-state — exchange last-synced sequence numbers
export const syncState = {
  preencode (state, m) {
    c.buffer.preencode(state, toBuffer32(m.feedKey))
    c.uint.preencode(state, m.localSeq)
    c.uint.preencode(state, m.remoteSeq)
  },
  encode (state, m) {
    c.buffer.encode(state, toBuffer32(m.feedKey))
    c.uint.encode(state, m.localSeq)
    c.uint.encode(state, m.remoteSeq)
  },
  decode (state) {
    return {
      feedKey: c.buffer.decode(state).toString('hex'),
      localSeq: c.uint.decode(state),
      remoteSeq: c.uint.decode(state)
    }
  }
}

// Message 1: file-offer — announce a file change
export const fileOffer = {
  preencode (state, m) {
    c.string.preencode(state, m.path)
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.uint.preencode(state, m.size)
    c.uint.preencode(state, m.mtime)
    c.uint8.preencode(state, m.op)
  },
  encode (state, m) {
    c.string.encode(state, m.path)
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.uint.encode(state, m.size)
    c.uint.encode(state, m.mtime)
    c.uint8.encode(state, m.op)
  },
  decode (state) {
    return {
      path: c.string.decode(state),
      contentHash: c.buffer.decode(state).toString('hex'),
      size: c.uint.decode(state),
      mtime: c.uint.decode(state),
      op: c.uint8.decode(state)
    }
  }
}

// Message 2: file-request — request a file transfer
export const fileRequest = {
  preencode (state, m) {
    c.string.preencode(state, m.path)
    c.buffer.preencode(state, toBuffer32(m.contentHash))
    c.buffer.preencode(state, m.chunksHave || Buffer.alloc(0))
  },
  encode (state, m) {
    c.string.encode(state, m.path)
    c.buffer.encode(state, toBuffer32(m.contentHash))
    c.buffer.encode(state, m.chunksHave || Buffer.alloc(0))
  },
  decode (state) {
    return {
      path: c.string.decode(state),
      contentHash: c.buffer.decode(state).toString('hex'),
      chunksHave: c.buffer.decode(state)
    }
  }
}

// ── Transfer Messages (3-8) ──────────────────────────────────

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

// Message 6: chunk-cancel — cancel a pending transfer
export const chunkCancel = {
  preencode (state, m) { c.string.preencode(state, m.path) },
  encode (state, m) { c.string.encode(state, m.path) },
  decode (state) { return { path: c.string.decode(state) } }
}

// Message 7: transfer-complete — confirm file fully received
export const transferComplete = {
  preencode (state, m) {
    c.string.preencode(state, m.path)
    c.buffer.preencode(state, toBuffer32(m.contentHash))
  },
  encode (state, m) {
    c.string.encode(state, m.path)
    c.buffer.encode(state, toBuffer32(m.contentHash))
  },
  decode (state) {
    return {
      path: c.string.decode(state),
      contentHash: c.buffer.decode(state).toString('hex')
    }
  }
}

// Message 8: conflict — notify peer of a detected conflict
export const conflict = {
  preencode (state, m) {
    c.string.preencode(state, m.path)
    c.buffer.preencode(state, toBuffer32(m.myHash))
    c.buffer.preencode(state, toBuffer32(m.theirHash))
    c.buffer.preencode(state, toBuffer32(m.ancestorHash || Buffer.alloc(32)))
  },
  encode (state, m) {
    c.string.encode(state, m.path)
    c.buffer.encode(state, toBuffer32(m.myHash))
    c.buffer.encode(state, toBuffer32(m.theirHash))
    c.buffer.encode(state, toBuffer32(m.ancestorHash || Buffer.alloc(32)))
  },
  decode (state) {
    return {
      path: c.string.decode(state),
      myHash: c.buffer.decode(state).toString('hex'),
      theirHash: c.buffer.decode(state).toString('hex'),
      ancestorHash: c.buffer.decode(state).toString('hex')
    }
  }
}

// ── Tree Messages (9-11) — 0.5a extension ────────────────────

// Encode/decode an array of tree entries: { kind, exec, name, childHash, size }
const treeEntryArray = {
  preencode (state, arr) {
    c.uint32.preencode(state, arr.length)
    for (const e of arr) {
      c.uint8.preencode(state, e.kind)
      c.uint8.preencode(state, e.exec || 0)
      c.string.preencode(state, e.name)
      state.end += 32 // childHash fixed32
      c.uint.preencode(state, e.size || 0)
    }
  },
  encode (state, arr) {
    c.uint32.encode(state, arr.length)
    for (const e of arr) {
      c.uint8.encode(state, e.kind)
      c.uint8.encode(state, e.exec || 0)
      c.string.encode(state, e.name)
      toBuffer32(e.childHash).copy(state.buffer, state.start, 0, 32)
      state.start += 32
      c.uint.encode(state, e.size || 0)
    }
  },
  decode (state) {
    const len = c.uint32.decode(state)
    const arr = []
    for (let i = 0; i < len; i++) {
      const kind = c.uint8.decode(state)
      const exec = c.uint8.decode(state)
      const name = c.string.decode(state)
      const childHash = state.buffer.subarray(state.start, state.start + 32).toString('hex')
      state.start += 32
      const size = c.uint.decode(state)
      arr.push({ kind, exec, name, childHash, size })
    }
    return arr
  }
}

// Message 9: tree-request — ask peer for a tree by its content hash
//
// [mirall] §4.15 — `nonce` (per-request id) is appended last; the holder echoes it in
// every treeResponse page so the requester can drop pages from a superseded attempt.
// A pre-nonce peer omits it and decodes 0, which the requester treats as "unverifiable".
export const treeRequest = {
  preencode (state, m) {
    c.buffer.preencode(state, toBuffer32(m.hash))
    c.uint.preencode(state, m.nonce || 0)
  },
  encode (state, m) {
    c.buffer.encode(state, toBuffer32(m.hash))
    c.uint.encode(state, m.nonce || 0)
  },
  decode (state) {
    const hash = c.buffer.decode(state).toString('hex')
    const nonce = state.start < state.end ? c.uint.decode(state) : 0
    return { hash, nonce }
  }
}

// Message 10: tree-response — return a tree's entries to the requester
//
// [mirall] §4.15 — `more` (paging flag) mirrors chunkHashes: a tree too large for one
// 16 MiB-1 Noise frame is split into several frames, every page but the last more:1.
// `nonce` echoes the requester's per-request id so pages from a superseded attempt are
// dropped. Both are appended last; a pre-paging peer omits them and decodes 0.
export const treeResponse = {
  preencode (state, m) {
    c.buffer.preencode(state, toBuffer32(m.hash))
    treeEntryArray.preencode(state, m.entries)
    c.uint8.preencode(state, m.more || 0)
    c.uint.preencode(state, m.nonce || 0)
  },
  encode (state, m) {
    c.buffer.encode(state, toBuffer32(m.hash))
    treeEntryArray.encode(state, m.entries)
    c.uint8.encode(state, m.more || 0)
    c.uint.encode(state, m.nonce || 0)
  },
  decode (state) {
    const hash = c.buffer.decode(state).toString('hex')
    const entries = treeEntryArray.decode(state)
    const more = state.start < state.end ? c.uint8.decode(state) : 0
    const nonce = state.start < state.end ? c.uint.decode(state) : 0
    return { hash, entries, more, nonce }
  }
}

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
