import test from 'brittle'
import c from 'compact-encoding'
import * as m from '../../src/shared/transfer/backends/overlay/engine/wire/messages.js'
import { SLOTS, isRetired, VERSION, MIN_VERSION, CAPABILITIES } from '../../src/shared/transfer/backends/overlay/engine/wire/slots.js'

// v1.8.0 through v1.11.2 register these fifteen, in this order; protomux routes by position.
const WIRE_ORDER = ['syncState', 'fileOffer', 'fileRequest', 'chunkHashes', 'chunkNeed', 'chunkData', 'chunkCancel',
  'transferComplete', 'conflict', 'treeRequest', 'treeResponse', 'contentRequest', 'transferControl',
  'transferProgress', 'keepAlive']

test('the slot table is the released wire order', (t) => {
  t.alike(SLOTS.map((s) => s.name), WIRE_ORDER)
})

test('a live slot carries its codec, a retired one raw bytes', (t) => {
  for (const slot of SLOTS) t.is(slot.codec, isRetired(slot) ? c.raw : m[slot.name], slot.name)
  t.alike(SLOTS.filter(isRetired).map((s) => s.name), ['syncState', 'fileOffer', 'fileRequest', 'chunkCancel', 'transferComplete', 'conflict', 'treeRequest', 'treeResponse'])
})

test('the channel announces v2 with both capabilities and refuses no released version', (t) => {
  t.is(VERSION, 2)
  t.is(MIN_VERSION, 1)
  t.is(CAPABILITIES, 0x03)
})
