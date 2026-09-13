// Which file in which share, as one string. It is a Hyperbee key under the `verified:` namespace, so
// the separator is load-bearing: verifiedPrefix builds the range bound the scan reads back with, and
// the two must agree byte for byte or the scan returns nothing.
//
// A space-root loose file has no share, so it takes LOOSE_SHARE_ID in that position — which is why
// the loose form is this function rather than a second grammar.
export const ENTRY_SEP = '|'

export function entryRef(shareId, relPath) {
  return shareId + ENTRY_SEP + relPath
}

// The prefix every entryRef for one share shares, ending in the separator so prefixRange can bound
// it — see core/bee-keys.js, which refuses a prefix that does not.
export function verifiedPrefix(spaceId, shareId) {
  return 'verified:' + spaceId + ':' + shareId + ENTRY_SEP
}
