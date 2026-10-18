// Boot, the relay handler and ManagedConfig all apply the relay through this one function, so the
// live relay always equals the person's own with the organization's locked values on top.
import { getSettings } from './settings-store.js'
import { getRelayConfig, setRelayConfig } from './runtime-config.js'
import { getManagedOverlay, getOrgRelayTest } from './managed-overlay.js'
import { effectiveNetwork } from './managed-effective.js'

export function applyEffectiveRelay({ applyRelayConfig, identityPending = getRelayConfig().identityPending }) {
  const effective = effectiveNetwork(getSettings().network, getManagedOverlay(), getOrgRelayTest())
  setRelayConfig(effective.relayMode, effective.relay, { identityPending })
  return applyRelayConfig()
}
