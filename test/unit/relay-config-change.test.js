import test from 'brittle'
import { relayConfigRow } from '../../src/shared/audit/relay-config-change.js'
import { buildRecord } from '../../src/shared/audit/audit-record.js'
import { truncateRelayKey } from '../../src/shared/contract/relay-key.js'

const KEY_A = 'yry4bqaudkr5bn9wf7pjfka1rf6m6r7yb9c4e7t5j8njbke6xk7q'
const KEY_B = 'usdgj55ym13jkwz7nyrn4tf9yog5ocqhgbzpmiapfunqoj398xqo'

const slot = (publicKey, label = '', kind = 'open', over = {}) => ({ publicKey, kind, label, enabled: true, lastTest: null, ...over })
const at = (mode, relay) => ({ mode, relay })

test('adding a relay while off writes one added row, not a turned-on row as well', (t) => {
  const change = relayConfigRow(at('off', null), at('auto', slot(KEY_A, 'Hetzner')))
  t.is(change.kind, 'relay.added')
  t.is(change.row.actor.type, 'self')
  t.alike(change.row.target, { kind: 'relay', id: truncateRelayKey(KEY_A), name: 'Hetzner' })
  t.alike(change.row.subject, { relayKind: 'open', mode: 'auto' })
})

test('adding a relay names the mode it came in with', (t) => {
  const change = relayConfigRow(at('always', null), at('always', slot(KEY_A, '', 'private')))
  t.is(change.kind, 'relay.added')
  t.is(change.row.subject.mode, 'always')
  t.is(change.row.subject.relayKind, 'private')
})

test('a different key or kind is a replace that names what it replaced', (t) => {
  const byKey = relayConfigRow(at('auto', slot(KEY_A, 'Old box')), at('auto', slot(KEY_B)))
  t.is(byKey.kind, 'relay.replaced')
  t.is(byKey.row.target.name, truncateRelayKey(KEY_B))
  t.is(byKey.row.subject.previous, truncateRelayKey(KEY_A))
  t.is(byKey.row.subject.previousLabel, 'Old box')
  t.absent('mode' in byKey.row.subject, 'the mode did not change')

  const byKind = relayConfigRow(at('auto', slot(KEY_A)), at('auto', slot(KEY_A, '', 'private')))
  t.is(byKind.kind, 'relay.replaced')
  t.is(byKind.row.subject.relayKind, 'private')
})

test('renaming the same relay is no relay change', (t) => {
  t.is(relayConfigRow(at('auto', slot(KEY_A, 'Home')), at('auto', slot(KEY_A, 'Office'))), null)
  const toggled = relayConfigRow(at('off', slot(KEY_A, 'Home')), at('auto', slot(KEY_A, 'Office')))
  t.is(toggled.kind, 'relay.turned_on', 'a mode change riding with it is still recorded')
  t.is(toggled.row.target.name, 'Office', 'under the name the relay has now')
})

test('a replace that turns relays on says so', (t) => {
  const change = relayConfigRow(at('off', slot(KEY_A)), at('auto', slot(KEY_B)))
  t.is(change.kind, 'relay.replaced')
  t.is(change.row.subject.mode, 'auto')
})

test('removing a relay writes one removed row, never a turned-off row as well', (t) => {
  const change = relayConfigRow(at('always', slot(KEY_A, 'Hetzner', 'private')), at('off', null))
  t.is(change.kind, 'relay.removed')
  t.is(change.row.target.name, 'Hetzner')
  t.alike(change.row.subject, { relayKind: 'private' })
})

test('turning the relay on names the mode it came back in', (t) => {
  for (const mode of ['auto', 'always']) {
    const change = relayConfigRow(at('off', slot(KEY_A)), at(mode, slot(KEY_A)))
    t.is(change.kind, 'relay.turned_on')
    t.is(change.row.subject.mode, mode)
  }
})

test('turning the relay off writes turned_off from either mode', (t) => {
  for (const mode of ['auto', 'always']) {
    const change = relayConfigRow(at(mode, slot(KEY_A)), at('off', slot(KEY_A)))
    t.is(change.kind, 'relay.turned_off')
    t.absent('mode' in change.row.subject)
  }
})

test('switching between auto and always is a mode change that names both modes', (t) => {
  const up = relayConfigRow(at('auto', slot(KEY_A)), at('always', slot(KEY_A)))
  t.is(up.kind, 'relay.mode_changed')
  t.is(up.row.subject.mode, 'always')

  const down = relayConfigRow(at('always', slot(KEY_A)), at('auto', slot(KEY_A)))
  t.is(down.kind, 'relay.mode_changed')
  t.is(down.row.subject.mode, 'auto')
})

test('a save that changes only the probe verdict, or nothing, writes nothing', (t) => {
  const tested = slot(KEY_A, 'Hetzner', 'open', { lastTest: { at: 1, ok: true } })
  t.is(relayConfigRow(at('auto', slot(KEY_A, 'Hetzner')), at('auto', tested)), null, 'probe verdict')
  t.is(relayConfigRow(at('auto', slot(KEY_A)), at('auto', slot(KEY_A))), null, 'nothing')
})

test('a mode change with no relay configured writes nothing', (t) => {
  t.is(relayConfigRow(at('off', null), at('auto', null)), null)
  t.is(relayConfigRow(at('always', null), at('off', null)), null)
})

test('a missing label and an empty one are the same slot', (t) => {
  const bare = { publicKey: KEY_A, kind: 'open', enabled: true }
  t.is(relayConfigRow(at('auto', bare), at('auto', slot(KEY_A, ''))), null)
})

test('a disabled slot installs nothing, so it is no relay', (t) => {
  const disabled = slot(KEY_A, '', 'open', { enabled: false })
  t.is(relayConfigRow(at('off', disabled), at('auto', disabled)), null, 'turning on a disabled slot turns on nothing')
  t.is(relayConfigRow(at('off', null), at('auto', disabled)), null)
})

test('a slot without a key is no relay, and never throws into the save', (t) => {
  t.is(relayConfigRow(at('off', null), at('auto', { kind: 'open' })), null)
  t.is(relayConfigRow(at('off', null), at('auto', { publicKey: 42 })), null)
  t.is(relayConfigRow(at('auto', { publicKey: null }), at('off', null)), null)
})

test('an unlabelled relay is named by its masked key', (t) => {
  const change = relayConfigRow(at('off', null), at('auto', slot(KEY_A)))
  t.alike(change.row.target, { kind: 'relay', id: truncateRelayKey(KEY_A), name: truncateRelayKey(KEY_A) })
})

const EVERY_KIND = [
  [at('off', null), at('auto', slot(KEY_A, 'A'))],
  [at('auto', slot(KEY_A, 'A')), at('auto', slot(KEY_B, 'B'))],
  [at('auto', slot(KEY_A, 'A')), at('off', null)],
  [at('off', slot(KEY_A)), at('auto', slot(KEY_A))],
  [at('auto', slot(KEY_A)), at('off', slot(KEY_A))],
  [at('auto', slot(KEY_A)), at('always', slot(KEY_A))],
]

test('no row ever carries the full relay key', (t) => {
  const kinds = new Set()
  for (const [before, after] of EVERY_KIND) {
    const change = relayConfigRow(before, after)
    kinds.add(change.kind)
    const text = JSON.stringify(change)
    t.absent(text.includes(KEY_A) || text.includes(KEY_B), change.kind + ' holds the masked key only')
  }
  t.is(kinds.size, 6, 'every relay settings kind was produced')
})

test('every row builds a valid record', (t) => {
  for (const [before, after] of EVERY_KIND) {
    const change = relayConfigRow(before, after)
    const rec = buildRecord({ seq: 0, ts: 1, kind: change.kind, ...change.row })
    t.is(rec.category, 'network')
    t.is(rec.tier, 'A')
    t.is(rec.target.kind, 'relay')
    t.ok(Object.values(rec.subject).every((v) => v === null || ['string', 'number', 'boolean'].includes(typeof v)), 'scalar subject')
  }
})
