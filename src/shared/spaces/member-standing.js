// Which roster entries carry membership authority. An entry flagged `unverified` is the inviter a
// bearer invite names, held for display until the fold or an admitted handshake confirms it: every
// admission, approval, grant, serve and listing decision reads the verified roster only. Removal
// and keep decisions (gc keep-sets, the leave replay) read the raw roster, so the absence of
// verification never tears anything down.

/**
 * @template {{ publicKey: string, unverified?: boolean }} M
 * @param {M[] | null | undefined} members
 * @returns {M[]}
 */
export function verifiedMembers(members) {
  return (members || []).filter((m) => !m?.unverified)
}

/**
 * @param {{ publicKey: string, unverified?: boolean }[] | null | undefined} members
 * @param {string} key
 * @returns {boolean}
 */
export function isVerifiedMember(members, key) {
  return (members || []).some((m) => m?.publicKey === key && !m.unverified)
}

export function isUnverifiedMember(members, key) {
  return (members || []).some((m) => m?.publicKey === key && m.unverified === true)
}
