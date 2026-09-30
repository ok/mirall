// SPDX-License-Identifier: AGPL-3.0-only
// Derived from hyper-overlay lib/protocol-v2.js @ 6cac8ee (v0.2.9), Copyright (C) 2026 the
// hyper-overlay authors, licensed AGPL-3.0. Modified for Mirall in 2026; PROVENANCE.md
// lists the changes and carries the full license notice.

// The hyper-overlay/v2 channel's identity and its positional message table.

import c from 'compact-encoding'
import * as m from './messages.js'

export const PROTOCOL = 'hyper-overlay/v2'
export const VERSION = 2
// The lowest remote version a channel stays open for. 1 is the unannounced version, so nothing in
// the field is refused today; raise it in the change that drops a slot or changes a codec.
export const MIN_VERSION = 1
export const CAP_LOCAL_FILES = 0x01
export const CAP_ADAPTIVE_CHUNKS = 0x02
export const CAPABILITIES = CAP_LOCAL_FILES | CAP_ADAPTIVE_CHUNKS

// protomux routes a frame by the POSITION its message was registered at, so this order is the
// contract with every released peer: never remove, insert or reorder a row, and append new
// messages at the end. A retired slot keeps its position as raw bytes, which never decode, so no
// frame on it can throw and receiving one does nothing. Nothing sends on a retired slot.
export const SLOTS = Object.freeze([
  { name: 'syncState', codec: c.raw },
  { name: 'fileOffer', codec: c.raw },
  { name: 'fileRequest', codec: c.raw },
  { name: 'chunkHashes', codec: m.chunkHashes },
  { name: 'chunkNeed', codec: m.chunkNeed },
  { name: 'chunkData', codec: m.chunkData },
  { name: 'chunkCancel', codec: c.raw },
  { name: 'transferComplete', codec: c.raw },
  { name: 'conflict', codec: c.raw },
  { name: 'treeRequest', codec: c.raw },
  { name: 'treeResponse', codec: c.raw },
  { name: 'contentRequest', codec: m.contentRequest },
  { name: 'transferControl', codec: m.transferControl },
  { name: 'transferProgress', codec: m.transferProgress },
  { name: 'keepAlive', codec: m.keepAlive },
].map((slot) => Object.freeze(slot)))

export const isRetired = (slot) => slot.codec === c.raw
