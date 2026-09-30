// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay test/messages-v2.test.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; the vendored
// overlay's PROVENANCE.md carries the full license notice.

// Ported from hyper-overlay upstream test/messages-v2.test.js (6cac8ee). Body
// verbatim EXCEPT the contentRequest cases, updated for the [mirall] §4.1 `from`
// field. See src/shared/transfer/backends/overlay/engine/PROVENANCE.md.
import test from 'brittle'
import * as m from '../../src/shared/transfer/backends/overlay/engine/messages-v2.js'
import crypto from 'hypercore-crypto'

function roundTrip(t, codec, value) {
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

// ── Content request ───────────────────────────────────────────

test('contentRequest round-trip — with chunksHave + from', (t) => {
  roundTrip(t, m.contentRequest, {
    contentHash: fakeHash,
    chunksHave: crypto.randomBytes(128),
    from: 'a1b2c3d4e5f6'
  })
})

test('contentRequest round-trip — empty chunksHave', (t) => {
  // [mirall] port note: an empty buffer round-trips as a zero-length buffer under
  // compact-encoding@3.1.0, not null.
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

// ── [mirall] Message 14: keep-alive (FIX-BW9) ────────────────

test('keepAlive round-trip', (t) => {
  roundTrip(t, m.keepAlive, { contentHash: fakeHash, index: 4096 })
})

test('keepAlive accepts a missing index (defaults to 0)', (t) => {
  const state = { start: 0, end: 0, buffer: null }
  m.keepAlive.preencode(state, { contentHash: fakeHash2 })
  state.buffer = Buffer.alloc(state.end)
  m.keepAlive.encode(state, { contentHash: fakeHash2 })
  state.start = 0
  t.alike(m.keepAlive.decode(state), { contentHash: fakeHash2, index: 0 }, 'decodes with index 0')
})
