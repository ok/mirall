// Best-known identity for a member, merged from (highest priority first): live swarm meta (the
// handshake — freshest), the replicated profile bee, then whatever we already hold; the
// 'Unknown'/null placeholders rank last so we never regress a name we once knew. driveKey now also
// falls back to the replicated bee (profile.driveKey) so a member derived from records with no live
// handshake can still have its drive opened — otherwise that peer's files would be invisible.
// Returns { entry, changed }; changed is false when held already equals the merge (skip the write+emit).
export function mergeMemberIdentity ({ publicKey, meta, profile, held }) {
  const m = meta || {}
  const p = profile || {}
  const h = held || {}
  const entry = {
    publicKey,
    driveKey: m.driveKey ?? p.driveKey ?? h.driveKey ?? null,
    displayName: m.displayName || p.displayName || h.displayName || 'Unknown',
    avatar: m.avatar ?? p.avatar ?? h.avatar ?? null,
    looseCatalogKey: m.looseCatalogKey ?? p.looseCatalogKey ?? h.looseCatalogKey ?? null,
    looseCatalogKeyEnc: m.looseCatalogKeyEnc ?? p.looseCatalogKeyEnc ?? h.looseCatalogKeyEnc ?? null,
  }
  if (!held) return { entry, changed: true }
  const changed = ['driveKey', 'displayName', 'avatar', 'looseCatalogKey', 'looseCatalogKeyEnc'].some((k) => entry[k] !== (held[k] ?? null))
  return { entry, changed }
}
