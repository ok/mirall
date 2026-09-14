// The ordering is a product decision, not cosmetics: a randomised port mapping is
// overwhelmingly a carrier NAT, and no router setting fixes that one.
export function fixStepsFor(cause) {
  // There is no network at all — VPN and NAT advice is noise here.
  if (cause === 'os-offline') return ['turnOnNetwork']
  // The tunnel is the only route we have; disconnecting it is the first thing to try.
  if (cause === 'vpn-only-route') return ['vpn', 'otherNetwork']
  if (cause === 'symmetric-nat') return ['mobile', 'vpn', 'otherNetwork']
  return ['vpn', 'mobile', 'otherNetwork']
}

export function reachableState(status) {
  if (!status.dhtReady) return 'unknown'
  if (status.address.publicHost === null) return 'noAddress'
  if (status.address.publicPort === 0) return 'changingPorts'
  return 'yes'
}

export function formatDuration(ms) {
  if (!Number.isFinite(ms) || ms < 0) return '—'
  const minutes = Math.floor(ms / 60000)
  if (minutes < 1) return `${Math.max(0, Math.floor(ms / 1000))}s`
  if (minutes < 60) return `${minutes}m`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ${minutes % 60}m`
  return `${Math.floor(hours / 24)}d ${hours % 24}h`
}
