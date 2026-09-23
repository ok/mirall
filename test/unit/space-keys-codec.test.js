import test from 'brittle'
import b4a from 'b4a'
import { decodeVault, encodeVault, setEntry, keyForEpoch } from '../../src/shared/spaces/space-keys-codec.js'

const hex = (n) => n.toString(16).padStart(2, '0').repeat(32)
const key = (n) => b4a.from(hex(n), 'hex')
const toHex = (b) => b4a.toString(b, 'hex')

test('a v1 vault decodes every entry as epoch 0 with no history', (t) => {
  const map = decodeVault({ v: 1, entries: { s1: hex(1), s2: hex(2) } }, b4a.from)
  t.alike([...map.keys()], ['s1', 's2'])
  t.is(map.get('s1').epoch, 0)
  t.alike(map.get('s1').key, key(1))
  t.alike(map.get('s1').history, [])
  t.alike(map.get('s2').key, key(2))
})

test('an empty or absent entries object decodes to an empty vault', (t) => {
  t.is(decodeVault({ v: 1 }, b4a.from).size, 0)
  t.is(decodeVault({ v: 2, entries: {} }, b4a.from).size, 0)
  t.is(decodeVault(null, b4a.from).size, 0)
})

test('a v2 vault round-trips through encode/decode', (t) => {
  const map = new Map([['s1', { epoch: 2, key: key(3), history: [{ epoch: 0, key: key(1) }, { epoch: 1, key: key(2) }] }]])
  const encoded = encodeVault(map, toHex)
  t.is(encoded.v, 2)
  t.alike(decodeVault(encoded, b4a.from), map)
})

test('a vault whose every entry is at epoch 0 with no history encodes as v1, byte-compatible with an older reader', (t) => {
  const encoded = encodeVault(decodeVault({ v: 1, entries: { s1: hex(1), s2: hex(2) } }, b4a.from), toHex)
  t.alike(encoded, { v: 1, entries: { s1: hex(1), s2: hex(2) } })
})

test('one entry past epoch 0, or with history, moves the whole vault to v2', (t) => {
  const zero = { epoch: 0, key: key(1), history: [] }
  const rotated = { epoch: 1, key: key(2), history: [{ epoch: 0, key: key(1) }] }
  const encoded = encodeVault(new Map([['s1', zero], ['s2', rotated]]), toHex)
  t.is(encoded.v, 2)
  t.alike(encoded.entries.s1, { epoch: 0, key: hex(1), history: [] })
  t.alike(encoded.entries.s2, { epoch: 1, key: hex(2), history: [{ epoch: 0, key: hex(1) }] })
})

test('a v2 entry with no history array reads as no history', (t) => {
  const map = decodeVault({ v: 2, entries: { s1: { epoch: 1, key: hex(1) } } }, b4a.from)
  t.alike(map.get('s1'), { epoch: 1, key: key(1), history: [] })
})

test('a malformed v2 entry is refused, never silently dropped', (t) => {
  t.exception(() => decodeVault({ v: 2, entries: { s1: { key: hex(1) } } }, b4a.from), /malformed/, 'no epoch')
  t.exception(() => decodeVault({ v: 2, entries: { s1: { epoch: -1, key: hex(1) } } }, b4a.from), /malformed/, 'negative epoch')
  t.exception(() => decodeVault({ v: 2, entries: { s1: { epoch: 1.5, key: hex(1) } } }, b4a.from), /malformed/, 'fractional epoch')
  t.exception(() => decodeVault({ v: 2, entries: { s1: { epoch: 0 } } }, b4a.from), /malformed/, 'no key')
  t.exception(() => decodeVault({ v: 2, entries: { s1: null } }, b4a.from), /malformed/, 'null entry')
})

test('a malformed history item is refused the same way', (t) => {
  const withHistory = (history) => ({ v: 2, entries: { s1: { epoch: 1, key: hex(2), history } } })
  t.exception(() => decodeVault(withHistory([null]), b4a.from), /malformed/, 'null item')
  t.exception(() => decodeVault(withHistory([{ epoch: '0', key: hex(1) }]), b4a.from), /malformed/, 'string epoch')
  t.exception(() => decodeVault(withHistory([{ epoch: 0, key: 123 }]), b4a.from), /malformed/, 'non-string key')
  t.alike(decodeVault(withHistory([{ epoch: 0, key: hex(1) }]), b4a.from).get('s1').history, [{ epoch: 0, key: key(1) }])
})

test('setEntry: the same key at the same epoch is a no-op, a different one replaces it', (t) => {
  const e0 = setEntry(null, 0, key(1), b4a.equals)
  t.alike(e0, { epoch: 0, key: key(1), history: [] })
  t.is(setEntry(e0, 0, key(1), b4a.equals), e0, 'identical re-put returns the same entry')
  const replaced = setEntry(e0, 0, key(2), b4a.equals)
  t.alike(replaced, { epoch: 0, key: key(2), history: [] }, 'a re-grant at the same epoch replaces the key')
  t.alike(e0, { epoch: 0, key: key(1), history: [] }, 'the previous entry is not mutated')
})

test('setEntry: a higher epoch keeps every lower key as history, a lower epoch discards the later ones', (t) => {
  const e0 = setEntry(null, 0, key(1), b4a.equals)
  const e1 = setEntry(e0, 1, key(2), b4a.equals)
  t.alike(e1, { epoch: 1, key: key(2), history: [{ epoch: 0, key: key(1) }] })
  const e3 = setEntry(e1, 3, key(3), b4a.equals)
  t.alike(e3.history, [{ epoch: 0, key: key(1) }, { epoch: 1, key: key(2) }], 'history in epoch order')
  const back = setEntry(e3, 1, key(4), b4a.equals)
  t.alike(back, { epoch: 1, key: key(4), history: [{ epoch: 0, key: key(1) }] }, 'keys at or past the set epoch are gone')
})

test('keyForEpoch reads current and history, null otherwise', (t) => {
  const e1 = setEntry(setEntry(null, 0, key(1), b4a.equals), 1, key(2), b4a.equals)
  t.alike(keyForEpoch(e1, 1), key(2))
  t.alike(keyForEpoch(e1, 0), key(1))
  t.is(keyForEpoch(e1, 2), null)
  t.is(keyForEpoch(null, 0), null)
})
