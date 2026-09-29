// Names one saved change to the relay slot or mode as the Activity Log records it: at most one row
// per save. A slot change outranks the mode change that rides with it (adding a relay turns relays
// on and removing one turns them off, in the same save), so the row names the act the user took. A
// save that changes only the probe verdict or the label names nothing: the relay is the key and its
// kind. Rows carry the masked key, never the full one, because the log is exported whole. Pure.
import { TARGET_KIND } from '../contract/audit-kinds.js'
import { truncateRelayKey } from '../contract/relay-key.js'
import { selfActor, targetRef } from './audit-record.js'

// A slot with no key, or a disabled one, installs nothing (network/relay.js enabledRelayKeys), so it
// is no relay here either, and a malformed one cannot throw into the save this row describes.
const slotOf = (relay) => (relay && relay.enabled !== false && typeof relay.publicKey === 'string' ? relay : null)
const kindOf = (slot) => (slot.kind === 'private' ? 'private' : 'open')
const labelOf = (slot) => (typeof slot.label === 'string' && slot.label ? slot.label : null)
const sameRelay = (a, b) => a.publicKey === b.publicKey && kindOf(a) === kindOf(b)

function relayConfigChange(before, after) {
  const was = slotOf(before.relay)
  const now = slotOf(after.relay)
  if (!was && !now) return null
  if (!was) return { kind: 'relay.added', slot: now, subject: { mode: after.mode } }
  if (!now) return { kind: 'relay.removed', slot: was, subject: {} }
  if (!sameRelay(was, now)) {
    // Replacing a relay while relays are off turns them on in the same save.
    const mode = before.mode === after.mode ? {} : { mode: after.mode }
    return { kind: 'relay.replaced', slot: now, subject: { previous: truncateRelayKey(was.publicKey), previousLabel: labelOf(was), ...mode } }
  }
  if (before.mode === after.mode) return null
  if (before.mode === 'off') return { kind: 'relay.turned_on', slot: now, subject: { mode: after.mode } }
  if (after.mode === 'off') return { kind: 'relay.turned_off', slot: now, subject: {} }
  return { kind: 'relay.mode_changed', slot: now, subject: { mode: after.mode } }
}

// `before` and `after` are getRelayConfig() reads: the mode and the slot as stored. The target names
// the relay (masked key as id, label or masked key as name), so the subject holds only the detail.
export function relayConfigRow(before, after) {
  const change = relayConfigChange(before, after)
  if (!change) return null
  const masked = truncateRelayKey(change.slot.publicKey)
  return {
    kind: change.kind,
    row: {
      actor: selfActor(),
      target: targetRef(TARGET_KIND.RELAY, masked, labelOf(change.slot) ?? masked),
      subject: { relayKind: kindOf(change.slot), ...change.subject },
    },
  }
}
