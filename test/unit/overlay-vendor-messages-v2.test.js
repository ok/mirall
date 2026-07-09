// Ported from hyper-overlay upstream test/messages-v2.test.js (6cac8ee). Body
// verbatim EXCEPT the contentRequest cases, updated for the [mirall] §4.1 `from`
// field. See src/shared/transfer/backends/overlay/vendor/PROVENANCE.md.
import test from 'brittle'
import c from 'compact-encoding'
import * as m from '../../src/shared/transfer/backends/overlay/vendor/messages-v2.js'
import crypto from 'hypercore-crypto'

function roundTrip (t, codec, value) {
  const state = { start: 0, end: 0, buffer: null }
  codec.preencode(state, value)
  state.buffer = Buffer.alloc(state.end)
  codec.encode(state, value)
  state.start = 0
  const decoded = codec.decode(state)
  t.alike(decoded, value, 'round-trip')
  return decoded
}

const fakeHash = 'a'.repeat(64)
const fakeHash2 = 'b'.repeat(64)
const fakeHash3 = 'c'.repeat(64)

// ── Handshake ─────────────────────────────────────────────────

test('handshake round-trip', (t) => {
  roundTrip(t, m.handshake, { version: 2, capabilities: 3 })
})

// ── Sync messages ─────────────────────────────────────────────

test('syncState round-trip', (t) => {
  roundTrip(t, m.syncState, {
    feedKey: fakeHash,
    localSeq: 42,
    remoteSeq: 15
  })
})

test('fileOffer round-trip (put)', (t) => {
  roundTrip(t, m.fileOffer, {
    path: '/docs/report.pdf',
    contentHash: fakeHash,
    size: 524288,
    mtime: 1712345678,
    op: 0
  })
})

test('fileOffer round-trip (delete)', (t) => {
  roundTrip(t, m.fileOffer, {
    path: '/docs/old.txt',
    contentHash: '0'.repeat(64),
    size: 0,
    mtime: 0,
    op: 1
  })
})

test('fileRequest round-trip (no chunks)', (t) => {
  // [mirall] port note: upstream's compact-encoding decoded an empty buffer to
  // null; Mirall's compact-encoding@3.1.0 decodes it to a zero-length buffer.
  // Overlay never sends a non-null chunksHave, so the distinction is immaterial.
  roundTrip(t, m.fileRequest, {
    path: '/docs/report.pdf',
    contentHash: fakeHash,
    chunksHave: Buffer.alloc(0)
  })
})

test('fileRequest round-trip (with chunks)', (t) => {
  roundTrip(t, m.fileRequest, {
    path: '/docs/report.pdf',
    contentHash: fakeHash,
    chunksHave: Buffer.from([0x01, 0x02, 0x03])
  })
})

// ── Transfer messages ─────────────────────────────────────────

test('chunkHashes round-trip', (t) => {
  roundTrip(t, m.chunkHashes, {
    path: '/docs/report.pdf',
    tier: 1,
    chunks: [
      { hash: fakeHash, length: 16384 },
      { hash: fakeHash2, length: 12288 },
      { hash: fakeHash3, length: 8192 }
    ],
    more: 0
  })
})

test('chunkHashes round-trip (empty)', (t) => {
  roundTrip(t, m.chunkHashes, {
    path: '/empty',
    tier: 0,
    chunks: [],
    more: 0
  })
})

// [mirall] §4.12 — paging flag round-trips, and a pre-paging frame (no trailing
// `more` byte) decodes to more:0 so a mixed-version swarm stays compatible.
test('chunkHashes round-trip (more:1 — a non-final page)', (t) => {
  roundTrip(t, m.chunkHashes, {
    path: '/big',
    tier: 3,
    chunks: [{ hash: fakeHash, length: 1048576 }],
    more: 1
  })
})

test('chunkHashes — omitted more encodes/decodes as 0', (t) => {
  const value = { path: '/docs/report.pdf', tier: 1, chunks: [{ hash: fakeHash, length: 16384 }] }
  const state = { start: 0, end: 0, buffer: null }
  m.chunkHashes.preencode(state, value)
  state.buffer = Buffer.alloc(state.end)
  m.chunkHashes.encode(state, value)
  state.start = 0
  const decoded = m.chunkHashes.decode(state)
  t.is(decoded.more, 0, 'omitted more → 0 (single, complete page)')
  t.alike(decoded.chunks, value.chunks)
})

test('chunkHashes — a pre-paging frame (no trailing byte) decodes to more:0', (t) => {
  // Encode with the current codec (which appends more:0), then strip the single
  // trailing more byte to reproduce exactly what an older peer puts on the wire.
  const value = { path: '/legacy', tier: 2, chunks: [{ hash: fakeHash, length: 8192 }], more: 0 }
  const state = { start: 0, end: 0, buffer: null }
  m.chunkHashes.preencode(state, value)
  state.buffer = Buffer.alloc(state.end)
  m.chunkHashes.encode(state, value)

  // Old frame = our encoding minus the appended uint8 more (always 1 byte, last).
  const oldFrame = state.buffer.subarray(0, state.buffer.length - 1)
  const dstate = { start: 0, end: oldFrame.length, buffer: oldFrame }
  const decoded = m.chunkHashes.decode(dstate)
  t.is(decoded.more, 0, 'missing trailing byte → more:0')
  t.is(decoded.path, '/legacy')
  t.alike(decoded.chunks, [{ hash: fakeHash, length: 8192 }])
})

test('chunkNeed round-trip', (t) => {
  roundTrip(t, m.chunkNeed, {
    path: '/docs/report.pdf',
    indices: [0, 2, 5, 10, 99]
  })
})

test('chunkNeed round-trip (empty)', (t) => {
  roundTrip(t, m.chunkNeed, {
    path: '/file',
    indices: []
  })
})

test('chunkData round-trip', (t) => {
  const data = crypto.randomBytes(16384)
  roundTrip(t, m.chunkData, {
    path: '/docs/report.pdf',
    index: 7,
    data
  })
})

test('chunkCancel round-trip', (t) => {
  roundTrip(t, m.chunkCancel, {
    path: '/docs/report.pdf'
  })
})

test('transferComplete round-trip', (t) => {
  roundTrip(t, m.transferComplete, {
    path: '/docs/report.pdf',
    contentHash: fakeHash
  })
})

test('conflict round-trip', (t) => {
  roundTrip(t, m.conflict, {
    path: '/docs/report.pdf',
    myHash: fakeHash,
    theirHash: fakeHash2,
    ancestorHash: fakeHash3
  })
})

test('conflict with null ancestor', (t) => {
  const result = roundTrip(t, m.conflict, {
    path: '/new-file.txt',
    myHash: fakeHash,
    theirHash: fakeHash2,
    ancestorHash: '0'.repeat(64)
  })
  t.is(result.ancestorHash, '0'.repeat(64))
})

// ── Large payloads ────────────────────────────────────────────

test('chunkHashes with 100 chunks', (t) => {
  const chunks = []
  for (let i = 0; i < 100; i++) {
    chunks.push({ hash: crypto.randomBytes(32).toString('hex'), length: 16384 + i })
  }
  roundTrip(t, m.chunkHashes, { path: '/large', tier: 2, chunks, more: 0 })
})

test('chunkNeed with 500 indices', (t) => {
  const indices = []
  for (let i = 0; i < 500; i++) indices.push(i * 2)
  roundTrip(t, m.chunkNeed, { path: '/large', indices })
})

test('chunkData with 1MB payload', (t) => {
  roundTrip(t, m.chunkData, {
    path: '/big',
    index: 0,
    data: crypto.randomBytes(1048576)
  })
})

// ── Tree messages (0.5a) ──────────────────────────────────────

test('treeRequest round-trip', (t) => {
  roundTrip(t, m.treeRequest, { hash: fakeHash, nonce: 0 })
})

test('treeRequest round-trip (with nonce)', (t) => {
  roundTrip(t, m.treeRequest, { hash: fakeHash, nonce: 42 })
})

test('treeRequest — omitted nonce decodes to 0', (t) => {
  const value = { hash: fakeHash }
  const state = { start: 0, end: 0, buffer: null }
  m.treeRequest.preencode(state, value)
  state.buffer = Buffer.alloc(state.end)
  m.treeRequest.encode(state, value)
  state.start = 0
  const decoded = m.treeRequest.decode(state)
  t.is(decoded.nonce, 0, 'omitted nonce → 0')
  t.is(decoded.hash, fakeHash)
})

test('treeResponse round-trip — empty entries', (t) => {
  roundTrip(t, m.treeResponse, { hash: fakeHash, entries: [], more: 0, nonce: 0 })
})

test('treeResponse round-trip — mixed file/dir/symlink entries', (t) => {
  roundTrip(t, m.treeResponse, {
    hash: fakeHash,
    entries: [
      { kind: 0, exec: 0, name: 'a.js', childHash: fakeHash2, size: 1024 },
      { kind: 0, exec: 1, name: 'run.sh', childHash: fakeHash3, size: 256 },
      { kind: 1, exec: 0, name: 'lib', childHash: fakeHash, size: 50000 },
      { kind: 2, exec: 0, name: 'current', childHash: fakeHash2, size: 12 }
    ],
    more: 0,
    nonce: 0
  })
})

test('treeResponse round-trip — many entries', (t) => {
  const entries = []
  for (let i = 0; i < 500; i++) {
    entries.push({
      kind: 0,
      exec: 0,
      name: 'file-' + i + '.js',
      childHash: crypto.randomBytes(32).toString('hex'),
      size: i * 100
    })
  }
  roundTrip(t, m.treeResponse, { hash: fakeHash, entries, more: 0, nonce: 0 })
})

test('treeResponse preserves UTF-8 names', (t) => {
  roundTrip(t, m.treeResponse, {
    hash: fakeHash,
    entries: [
      { kind: 0, exec: 0, name: 'café.txt', childHash: fakeHash2, size: 10 },
      { kind: 0, exec: 0, name: '日本.md', childHash: fakeHash3, size: 20 }
    ],
    more: 0,
    nonce: 0
  })
})

// [mirall] §4.15 — paging flag + nonce round-trip, and a pre-paging frame (no trailing
// bytes) decodes to more:0/nonce:0 so a mixed-version swarm stays compatible.
test('treeResponse round-trip (more:1 + nonce — a non-final page)', (t) => {
  roundTrip(t, m.treeResponse, {
    hash: fakeHash,
    entries: [{ kind: 0, exec: 0, name: 'a.js', childHash: fakeHash2, size: 1024 }],
    more: 1,
    nonce: 7
  })
})

test('treeResponse — omitted more/nonce encode/decode as 0', (t) => {
  const value = { hash: fakeHash, entries: [{ kind: 1, exec: 0, name: 'lib', childHash: fakeHash2, size: 9 }] }
  const state = { start: 0, end: 0, buffer: null }
  m.treeResponse.preencode(state, value)
  state.buffer = Buffer.alloc(state.end)
  m.treeResponse.encode(state, value)
  state.start = 0
  const decoded = m.treeResponse.decode(state)
  t.is(decoded.more, 0, 'omitted more → 0 (single, complete page)')
  t.is(decoded.nonce, 0, 'omitted nonce → 0')
  t.alike(decoded.entries, value.entries)
})

test('treeResponse — a pre-paging frame (no trailing more/nonce) decodes to 0/0', (t) => {
  const value = { hash: fakeHash, entries: [{ kind: 0, exec: 0, name: 'x', childHash: fakeHash2, size: 3 }], more: 0, nonce: 0 }
  const state = { start: 0, end: 0, buffer: null }
  m.treeResponse.preencode(state, value)
  state.buffer = Buffer.alloc(state.end)
  m.treeResponse.encode(state, value)

  // Old upstream frame = our encoding minus the two appended uints (more, nonce), each 1 byte for 0.
  const oldFrame = state.buffer.subarray(0, state.buffer.length - 2)
  const dstate = { start: 0, end: oldFrame.length, buffer: oldFrame }
  const decoded = m.treeResponse.decode(dstate)
  t.is(decoded.more, 0, 'missing trailing bytes → more:0')
  t.is(decoded.nonce, 0, 'missing trailing bytes → nonce:0')
  t.is(decoded.hash, fakeHash)
  t.alike(decoded.entries, value.entries)
})

test('contentRequest round-trip — with chunksHave + from', (t) => {
  roundTrip(t, m.contentRequest, {
    contentHash: fakeHash,
    chunksHave: crypto.randomBytes(128),
    from: 'a1b2c3d4e5f6'
  })
})

test('contentRequest round-trip — empty chunksHave', (t) => {
  // [mirall] port note: see fileRequest no-chunks — empty buffer round-trips as
  // a zero-length buffer under compact-encoding@3.1.0, not null.
  roundTrip(t, m.contentRequest, {
    contentHash: fakeHash,
    chunksHave: Buffer.alloc(0),
    from: 'deadbeef'
  })
})

// ── Transfer-control (message 12) ─────────────────────────────

test('transferControl round-trip — paused', (t) => {
  roundTrip(t, m.transferControl, { contentHash: fakeHash, state: 0 })
})

test('transferControl round-trip — stopped', (t) => {
  roundTrip(t, m.transferControl, { contentHash: fakeHash2, state: 1 })
})

// [mirall] §4.1 — the `from` field is appended last; a sender that omits it
// encodes '' and the decoder yields from:'' (never undefined, never crashes).
test('contentRequest — omitted from decodes to empty string', (t) => {
  const state = { start: 0, end: 0, buffer: null }
  const value = { contentHash: fakeHash, chunksHave: null }
  m.contentRequest.preencode(state, value)
  state.buffer = Buffer.alloc(state.end)
  m.contentRequest.encode(state, value)
  state.start = 0
  const decoded = m.contentRequest.decode(state)
  t.is(decoded.from, '', 'omitted from → empty string')
  t.is(decoded.contentHash, fakeHash)
})

// ── Transfer-progress (message 13) ────────────────────────────

test('transferProgress round-trip — have baseline', (t) => {
  roundTrip(t, m.transferProgress, { contentHash: fakeHash, have: 123456789 })
})

test('transferProgress round-trip — zero have', (t) => {
  roundTrip(t, m.transferProgress, { contentHash: fakeHash2, have: 0 })
})
