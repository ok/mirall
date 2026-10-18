// The effective value of each managed key: a locked managed value wins, otherwise the person's own.
// Nothing here writes, so leaving drops the overlay and the person's settings are as they left them.
import { MAX_LABEL_LENGTH } from '../network/relay-slot.js'

export function effectiveNetwork(own, managed, orgRelayTest = null) {
  const m = managed?.settings ?? {}
  const relayMode = m['network.relayMode'] ?? own.relayMode
  const relay = typeof m['network.relayKey'] === 'string'
    ? { publicKey: m['network.relayKey'], kind: 'open', label: managed.organization.name.slice(0, MAX_LABEL_LENGTH), enabled: true, lastTest: orgRelayTest }
    : own.relay
  return { relayMode, relay }
}

export function effectiveAudit(stored, managed) {
  const m = managed?.settings ?? {}
  return { ...stored, enabled: m['audit.enabled'] ?? stored.enabled, retentionDays: m['audit.retentionDays'] ?? stored.retentionDays }
}

export function effectiveBackup(own, managed) {
  return {
    folder: managed?.backup?.folder ?? own.folder,
    managed: managed?.backup ?? null,
    required: managed?.settings?.['backup.required'] === true,
  }
}

// A backup folder template locks only where it resolved: one that does not resolve on this device
// leaves the person's own folder in place, so it must not refuse it either.
export const lockedKeys = (managed) => Object.keys(managed?.settings ?? {})
  .filter((key) => !key.startsWith('backup.folder.') || managed.backup !== null)
