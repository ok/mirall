// Whether a mirror pass may reach for content at all, kept pure so the rule is asserted directly
// rather than through a live swarm — the same shape as mirror-walk.js.
//
// A self-mirror is always reachable: presence leases track REMOTE peers only, so our own key is
// never in the map and a bare isOwnerOnline(ownerKey) reads every self-mirror as permanently
// offline. share-listing.js carries the same special case for the same reason.
export function mirrorMayFetch({ ownerKey = null, localKey = null, ownerOnline = false } = {}) {
  // Unknown falls open: a mirror that goes quiet on a missing field is a silent sync outage, where
  // a wasted pass is a log line.
  if (!ownerKey) return true
  if (localKey && ownerKey === localKey) return true
  return !!ownerOnline
}
