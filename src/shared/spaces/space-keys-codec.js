// The SCK vault's plaintext shape, both versions. A v1 entry is one bare hex key per space; a v2
// entry holds the current epoch, its key and the history of earlier epochs, so a member can still
// read a catalog its owner has not rolled forward yet. A v1 entry decodes as epoch 0 with no
// history — epoch 0 is the derived key — and a vault whose every entry is still at epoch 0 with no
// history encodes as v1, so a release that reads only v1 opens it. Pure: the file, the envelope
// and the vault key are space-keys.js's job, and the byte helpers are injected so test/unit can
// drive this under plain Node.

function decodeKeyed(spaceId, item, from) {
  if (!item || typeof item.key !== 'string' || !Number.isInteger(item.epoch) || item.epoch < 0) {
    throw new Error('space-keys: malformed vault entry for ' + spaceId)
  }
  return { epoch: item.epoch, key: from(item.key, 'hex') }
}

function decodeEntry(spaceId, entry, from) {
  if (typeof entry === 'string') return { epoch: 0, key: from(entry, 'hex'), history: [] }
  const current = decodeKeyed(spaceId, entry, from)
  const history = Array.isArray(entry.history) ? entry.history : []
  return { ...current, history: history.map((h) => decodeKeyed(spaceId, h, from)) }
}

// Map<spaceId, { epoch, key, history: [{ epoch, key }] }> from the parsed plaintext.
export function decodeVault(obj, from) {
  const map = new Map()
  for (const [spaceId, entry] of Object.entries(obj?.entries || {})) {
    map.set(spaceId, decodeEntry(spaceId, entry, from))
  }
  return map
}

const isEpochZeroOnly = (entry) => entry.epoch === 0 && entry.history.length === 0

export function encodeVault(map, toHex) {
  const entries = {}
  if ([...map.values()].every(isEpochZeroOnly)) {
    for (const [spaceId, { key }] of map) entries[spaceId] = toHex(key)
    return { v: 1, entries }
  }
  for (const [spaceId, { epoch, key, history }] of map) {
    entries[spaceId] = {
      epoch,
      key: toHex(key),
      history: history.map((h) => ({ epoch: h.epoch, key: toHex(h.key) })),
    }
  }
  return { v: 2, entries }
}

// Set the key for one epoch. Every key at a lower epoch is kept as history; the key at the same
// epoch and any key at a higher one are replaced — the caller (a grant, later the fold) decides
// which key an epoch has, and the vault holds what it was told. The same key at the same epoch
// returns the entry unchanged.
export function setEntry(entry, epoch, key, equals) {
  if (!entry) return { epoch, key, history: [] }
  if (epoch === entry.epoch && equals(entry.key, key)) return entry
  const known = [...entry.history, { epoch: entry.epoch, key: entry.key }]
  const history = known.filter((h) => h.epoch < epoch).sort((a, b) => a.epoch - b.epoch)
  return { epoch, key, history }
}

export function keyForEpoch(entry, epoch) {
  if (!entry) return null
  if (epoch === entry.epoch) return entry.key
  return entry.history.find((h) => h.epoch === epoch)?.key ?? null
}
