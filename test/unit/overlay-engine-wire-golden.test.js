import test from 'brittle'
import c from 'compact-encoding'
import { readFileSync } from 'fs'
import * as m from '../../src/shared/transfer/backends/overlay/engine/messages-v2.js'
import { LEGACY_FRAMES } from '../helpers/legacy-overlay-frames.js'

const golden = JSON.parse(readFileSync(new URL('../fixtures/overlay-wire/v1.json', import.meta.url), 'utf8'))
const revive = (v) => JSON.parse(JSON.stringify(v), (_k, x) => (x && typeof x === 'object' && '$buf' in x ? Buffer.from(x.$buf, 'hex') : x))

// Round-trip tests cannot catch a symmetric codec change: encode and decode move together and
// still agree. These pin the bytes a released peer puts on the wire.
for (const [name, { value, hex }] of Object.entries(golden.live)) {
  test(`${name}: encodes to the released bytes`, (t) => {
    t.is(c.encode(m[name], revive(value)).toString('hex'), hex)
  })
  test(`${name}: decodes the released bytes`, (t) => {
    t.alike(c.decode(m[name], Buffer.from(hex, 'hex')), revive(value))
  })
}

// The test peer that plays an old or hostile node must speak the released bytes, or the
// "legacy frames are inert" tests prove nothing.
for (const [name, { value, hex }] of Object.entries(golden.retired)) {
  test(`${name}: the legacy frame builder emits the released bytes`, (t) => {
    t.is(LEGACY_FRAMES[name](revive(value)).toString('hex'), hex)
  })
}

test('every retired slot has a pinned vector', (t) => {
  t.alike(Object.keys(golden.retired).sort(), Object.keys(LEGACY_FRAMES).sort())
})
